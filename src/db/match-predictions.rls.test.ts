/**
 * Live-DB test for `see-others-predictions` — the per-match reveal READ path.
 *
 * The blindness boundary (FR-015/FR-017) is exhaustively proven by
 * `predictions.rls.test.ts`; this test's unique value is asserting that the
 * `loadMatchPredictions` loader assembles the cross-participant rows ONLY
 * post-kickoff and in leaderboard-standings order — ordering that rides on
 * PostgREST's implicit `ORDER BY` through the `leaderboard` view, which a pure
 * unit test structurally cannot verify.
 *
 * Pinned against a REAL local Supabase stack (`npx supabase start`):
 *   (a) loadMatchPredictions(B, [pastMatchId]) reveals A's prediction + points,
 *       with A ordered ahead of B (A outscored B → leaderboard order survives),
 *   (b) loadMatchPredictions(B, [futureMatchId]) never surfaces A's pre-kickoff
 *       pick — A's participant row carries a null prediction (only B sees self),
 *   (c) a direct predictions read for the future match from B returns zero of
 *       A's rows (blindness smoke through the new read path).
 *
 * Self-skips unless the DB URL AND both keys are set, so default `npm test`
 * skips it. Run locally:
 *
 *   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_ANON_KEY=<Publishable key> \
 *   SUPABASE_SERVICE_ROLE_KEY=<Secret key> \
 *   npm test -- match-predictions.rls
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/database.types";
import { loadMatchPredictions } from "@/lib/match-predictions";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const dbConfigured = Boolean(process.env.SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@betcup.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "local-only";

const STAMP = Date.now().toString();
const PARTICIPANT_PASSWORD = "participant-only";
const ZONE = "Europe/Warsaw";

function freshClient(key: string): SupabaseClient<Database> {
  return createClient<Database>(SUPABASE_URL, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function signedInClient(email: string, password: string): Promise<SupabaseClient<Database>> {
  const client = freshClient(ANON_KEY);
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return client;
}

// This suite SEEDS and DELETES data (and the over-cap block bulk-inserts ~2100
// rows + auth users), so it must only ever touch a LOCAL stack. Refuse a
// non-loopback target even when creds are present, so a stray prod
// SUPABASE_URL/SUPABASE_DB_URL can never seed a real database.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function isLoopbackHost(rawUrl: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

function assertLoopbackTarget(): void {
  if (!isLoopbackHost(SUPABASE_URL) || !isLoopbackHost(process.env.SUPABASE_DB_URL ?? "")) {
    throw new Error(
      "match-predictions.rls: refusing to seed a non-loopback target — this suite is local-only. " +
        "Point SUPABASE_URL and SUPABASE_DB_URL at 127.0.0.1/localhost.",
    );
  }
}

describe.skipIf(!dbConfigured)("match-predictions read path — reveal + ordering (live DB)", () => {
  let service: SupabaseClient<Database>;
  let admin: SupabaseClient<Database>;
  let participantA: SupabaseClient<Database>;
  let participantB: SupabaseClient<Database>;

  let tournamentId: string;
  let pastMatchId: string; // kicked off, has a result + both predictions
  let futureMatchId: string; // not kicked off — A + B predict via own sessions

  const userIds: string[] = [];
  let aUserId: string;
  let bUserId: string;

  async function createParticipant(displayName: string): Promise<string> {
    const email = `rls-mpred-${displayName}-${STAMP}@betcup.local`;
    const { data, error } = await service.auth.admin.createUser({
      email,
      password: PARTICIPANT_PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    });
    if (error) throw new Error(`create ${displayName} failed: ${error.message}`);
    userIds.push(data.user.id);
    return data.user.id;
  }

  async function seedMatch(kickoffIso: string, home: string, away: string): Promise<string> {
    const res = await admin
      .from("matches")
      .insert({ tournament_id: tournamentId, home_team: home, away_team: away, kickoff_time: kickoffIso })
      .select("id")
      .single();
    if (res.error) throw new Error(`seed match failed: ${res.error.message}`);
    return res.data.id;
  }

  async function seedPrediction(predictorId: string, matchId: string, home: number, away: number): Promise<void> {
    const res = await service
      .from("predictions")
      .insert({ predictor_id: predictorId, match_id: matchId, home_goals: home, away_goals: away });
    if (res.error) throw new Error(`seed prediction failed: ${res.error.message}`);
  }

  beforeAll(async () => {
    assertLoopbackTarget();
    service = freshClient(SERVICE_ROLE_KEY);

    aUserId = await createParticipant("a-viewer");
    bUserId = await createParticipant("b-target");

    admin = await signedInClient(ADMIN_EMAIL, ADMIN_PASSWORD);
    participantA = await signedInClient(`rls-mpred-a-viewer-${STAMP}@betcup.local`, PARTICIPANT_PASSWORD);
    participantB = await signedInClient(`rls-mpred-b-target-${STAMP}@betcup.local`, PARTICIPANT_PASSWORD);

    const tour = await admin
      .from("tournaments")
      .insert({ name: "Match-Predictions RLS Cup", time_zone: ZONE })
      .select("id")
      .single();
    if (tour.error) throw new Error(`tournament insert failed: ${tour.error.message}`);
    tournamentId = tour.data.id;

    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    pastMatchId = await seedMatch(past, "Past Home", "Past Away");
    futureMatchId = await seedMatch(future, "Future Home", "Future Away");

    // Past match result 2–1 (home win). A predicts it exactly (positive points);
    // B predicts a draw → wrong outcome → 0 points. So A outscores B and must
    // sort ahead of B in the leaderboard-ordered roster. Seeded via service-role
    // because the INSERT policy refuses post-kickoff writes.
    const r = await service.from("match_results").insert({ match_id: pastMatchId, home_score: 2, away_score: 1 });
    if (r.error) throw new Error(`seed result failed: ${r.error.message}`);
    await seedPrediction(aUserId, pastMatchId, 2, 1);
    await seedPrediction(bUserId, pastMatchId, 0, 0);

    // Both predict the FUTURE match through their OWN sessions (real INSERT path).
    // A's pick is the blindness teeth: it must never reach B via the loader.
    const aFuture = await participantA
      .from("predictions")
      .insert({ predictor_id: aUserId, match_id: futureMatchId, home_goals: 3, away_goals: 0 })
      .select("id");
    if (aFuture.error) throw new Error(`A future prediction insert failed: ${aFuture.error.message}`);

    const bFuture = await participantB
      .from("predictions")
      .insert({ predictor_id: bUserId, match_id: futureMatchId, home_goals: 1, away_goals: 1 })
      .select("id");
    if (bFuture.error) throw new Error(`B future prediction insert failed: ${bFuture.error.message}`);
  });

  afterAll(async () => {
    if (tournamentId) await service.from("tournaments").delete().eq("id", tournamentId);
    for (const id of userIds) await service.auth.admin.deleteUser(id);
  });

  // (a) Reveal + leaderboard ordering -------------------------------------

  it("reveals A's prediction + points to B for a kicked-off match, in leaderboard order", async () => {
    const views = await loadMatchPredictions(participantB, bUserId, [pastMatchId]);
    const view = views.get(pastMatchId);
    expect(view).toBeDefined();
    expect(view?.result).toEqual({ homeScore: 2, awayScore: 1 });

    const participants = view?.participants ?? [];
    const aRow = participants.find((p) => p.participantId === aUserId);
    const bRow = participants.find((p) => p.participantId === bUserId);

    // A's prediction + points are revealed post-kickoff.
    expect(aRow?.prediction).toEqual({ homeGoals: 2, awayGoals: 1 });
    expect(aRow?.points ?? 0).toBeGreaterThan(0); // exact → positive (scoring constant agnostic)
    expect(aRow?.isSelf).toBe(false);

    // B (the viewer) sees self; wrong-outcome prediction scores 0.
    expect(bRow?.prediction).toEqual({ homeGoals: 0, awayGoals: 0 });
    expect(bRow?.points).toBe(0);
    expect(bRow?.isSelf).toBe(true);

    // Leaderboard order survives the loader: A outscored B → A sorts first.
    const aIndex = participants.findIndex((p) => p.participantId === aUserId);
    const bIndex = participants.findIndex((p) => p.participantId === bUserId);
    expect(aIndex).toBeGreaterThanOrEqual(0);
    expect(bIndex).toBeGreaterThanOrEqual(0);
    expect(aIndex).toBeLessThan(bIndex);
  });

  // (b) Future match: A's pre-kickoff pick never appears -------------------

  it("never surfaces A's pre-kickoff prediction to B through the loader", async () => {
    // Simulate the app-clock treating the future match as kicked off; the DB's
    // match_is_kicked_off gate still hides A's row, so the loader must too.
    const views = await loadMatchPredictions(participantB, bUserId, [futureMatchId]);
    const view = views.get(futureMatchId);
    expect(view).toBeDefined();
    expect(view?.result).toBeNull();

    const participants = view?.participants ?? [];
    const aRow = participants.find((p) => p.participantId === aUserId);
    const bRow = participants.find((p) => p.participantId === bUserId);

    // A's future pick is blind to B → null prediction, null points.
    expect(aRow?.prediction).toBeNull();
    expect(aRow?.points).toBeNull();

    // B still sees its own future pick (owner branch of the SELECT policy).
    expect(bRow?.prediction).toEqual({ homeGoals: 1, awayGoals: 1 });
    expect(bRow?.isSelf).toBe(true);
  });

  // (c) Blindness smoke through the raw read ------------------------------

  it("returns zero of A's prediction rows for the future match from B's session", async () => {
    const { data, error } = await participantB
      .from("predictions")
      .select("id")
      .eq("match_id", futureMatchId)
      .eq("predictor_id", aUserId);

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });
});

/**
 * Regression guard for the row-cap truncation bug (change:
 * match-predictions-row-cap). `loadMatchPredictions` fans out its predictions +
 * prediction_scores reads to `participants x kicked-off matches` rows; without
 * pagination PostgREST silently truncates them at `max_rows` (1000, see
 * supabase/config.toml), dropping score rows so the dialog shows a fake 0.
 *
 * This seeds a dataset that DELIBERATELY exceeds 1000 prediction/score rows and
 * asserts every seeded participant's points survive across every seeded match.
 * Against the pre-fix loader this fails (truncated cells come back null/0);
 * against the paged loader it passes. Kept in its own suite so the heavier seed
 * only runs for this check. Self-skips without DB env, like the suite above.
 */
describe.skipIf(!dbConfigured)("match-predictions read path — over the row cap (live DB)", () => {
  // 6 x 175 = 1050 (predictions) and 1050 (scores) rows — both clear the 1000
  // cap with margin while keeping auth-user creation (the slow part) small.
  const N_PARTICIPANTS = 6;
  const N_MATCHES = 175;
  const EXPECTED_CELLS = N_PARTICIPANTS * N_MATCHES;

  let service: SupabaseClient<Database>;
  let viewer: SupabaseClient<Database>;
  let viewerId: string;
  let tournamentId: string;
  const participantIds: string[] = [];
  const userIds: string[] = [];
  const matchIds: string[] = [];

  beforeAll(async () => {
    assertLoopbackTarget();
    service = freshClient(SERVICE_ROLE_KEY);

    // Participants (real auth users → profiles via the signup trigger).
    for (let i = 0; i < N_PARTICIPANTS; i++) {
      const email = `rls-mpred-cap-${String(i)}-${STAMP}@betcup.local`;
      const { data, error } = await service.auth.admin.createUser({
        email,
        password: PARTICIPANT_PASSWORD,
        email_confirm: true,
        user_metadata: { display_name: `cap-${String(i)}` },
      });
      if (error) throw new Error(`create cap participant ${String(i)} failed: ${error.message}`);
      userIds.push(data.user.id);
      participantIds.push(data.user.id);
    }
    viewerId = participantIds[0];
    viewer = await signedInClient(`rls-mpred-cap-0-${STAMP}@betcup.local`, PARTICIPANT_PASSWORD);

    // Tournament + N_MATCHES kicked-off (past) matches, seeded via service-role
    // (bypasses RLS — pure fixture setup, not the code under test).
    const tour = await service
      .from("tournaments")
      .insert({ name: `Row-Cap RLS Cup ${STAMP}`, time_zone: ZONE })
      .select("id")
      .single();
    if (tour.error) throw new Error(`tournament insert failed: ${tour.error.message}`);
    tournamentId = tour.data.id;

    const base = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const matchRows = Array.from({ length: N_MATCHES }, (_, i) => ({
      tournament_id: tournamentId,
      home_team: `Home ${String(i)}`,
      away_team: `Away ${String(i)}`,
      // All comfortably in the past → kicked off → predictions revealed + scorable.
      kickoff_time: new Date(base + i * 60 * 1000).toISOString(),
    }));
    const inserted = await service.from("matches").insert(matchRows).select("id");
    if (inserted.error) throw new Error(`bulk match insert failed: ${inserted.error.message}`);
    for (const row of inserted.data) matchIds.push(row.id);

    // Every participant predicts every match EXACTLY right (1–0), and every match
    // resolves 1–0 → every cell scores the exact-match points (> 0). So any
    // null/0 cell in the assert means a row was dropped by truncation.
    const predictionRows = participantIds.flatMap((pid) =>
      matchIds.map((mid) => ({ predictor_id: pid, match_id: mid, home_goals: 1, away_goals: 0 })),
    );
    const predIns = await service.from("predictions").insert(predictionRows);
    if (predIns.error) throw new Error(`bulk prediction insert failed: ${predIns.error.message}`);

    const resultRows = matchIds.map((mid) => ({ match_id: mid, home_score: 1, away_score: 0 }));
    const resIns = await service.from("match_results").insert(resultRows);
    if (resIns.error) throw new Error(`bulk result insert failed: ${resIns.error.message}`);
  });

  afterAll(async () => {
    if (tournamentId) await service.from("tournaments").delete().eq("id", tournamentId);
    for (const id of userIds) await service.auth.admin.deleteUser(id);
  });

  it("returns every participant's points for every match past the 1000-row cap", async () => {
    // Sanity: the seed genuinely exceeds the cap, otherwise the guard is vacuous.
    expect(EXPECTED_CELLS).toBeGreaterThan(1000);

    const views = await loadMatchPredictions(viewer, viewerId, matchIds);
    expect(views.size).toBe(N_MATCHES);

    let checkedCells = 0;
    let missingCells = 0;
    for (const mid of matchIds) {
      const view = views.get(mid);
      expect(view).toBeDefined();
      for (const pid of participantIds) {
        const row = view?.participants.find((p) => p.participantId === pid);
        // An exact 1–0 prediction against a 1–0 result always scores > 0; a
        // truncated cell would surface as null (or a 0 from the no-prediction
        // branch) — either way it is caught here.
        const points = row?.points ?? null;
        if (points === null || points <= 0) missingCells++;
        checkedCells++;
      }
    }

    expect(checkedCells).toBe(EXPECTED_CELLS);
    expect(missingCells).toBe(0);
  });
});
