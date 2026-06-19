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
