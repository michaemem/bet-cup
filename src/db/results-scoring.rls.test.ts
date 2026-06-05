// @vitest-environment node
/**
 * Live-DB tests for S-04 (results, scoring & leaderboard).
 *
 * Three things are pinned here, all against a REAL local Supabase stack
 * (`npx supabase start`) because the logic lives in Postgres, not the client:
 *
 *   1. FR-018 scoring rule — exhaustive 16-case grid against the
 *      public.score_prediction() SQL function (3 exact / 2 same goal-difference
 *      / 1 same outcome / 0 wrong, in that load-bearing order).
 *   2. Leaderboard tie-break ordering — total_points → exact-score count →
 *      lower(display_name) — and FR-019 completeness (a non-predictor appears
 *      with total_points = 0).
 *   3. match_results write RLS — admin may upsert a result on a kicked-off
 *      match; a participant may not; the admin may NOT write a result on a
 *      not-yet-kicked-off match (the match_is_kicked_off guard); results are
 *      publicly selectable.
 *
 * Self-skips unless the DB URL AND both keys are set, so default `npm test`
 * skips it. Run locally:
 *
 *   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_ANON_KEY=<Publishable key> \
 *   SUPABASE_SERVICE_ROLE_KEY=<Secret key> \
 *   npm test -- results-scoring.rls
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/database.types";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const dbConfigured = Boolean(process.env.SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@betcup.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "local-only";

const STAMP = Date.now().toString();
const PARTICIPANT_PASSWORD = "participant-only";

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

/** One scoring case: (prediction, result) → expected FR-018 points. */
interface ScoringCase {
  readonly label: string;
  readonly p: readonly [number, number];
  readonly r: readonly [number, number];
  readonly expected: number;
}

// 16 cases spanning every FR-018 branch: exact / same-difference-nonexact /
// same-outcome-only / wrong-outcome, across home wins, away wins, and draws.
const SCORING_GRID: readonly ScoringCase[] = [
  // exact (3)
  { label: "exact home win", p: [2, 1], r: [2, 1], expected: 3 },
  { label: "exact draw", p: [1, 1], r: [1, 1], expected: 3 },
  { label: "exact away win", p: [0, 2], r: [0, 2], expected: 3 },
  // same goal-difference, not exact (2)
  { label: "same diff home win", p: [3, 1], r: [2, 0], expected: 2 },
  { label: "same diff away win", p: [1, 3], r: [0, 2], expected: 2 },
  { label: "same diff draw 2-2 vs 1-1", p: [2, 2], r: [1, 1], expected: 2 },
  { label: "same diff draw 0-0 vs 3-3", p: [0, 0], r: [3, 3], expected: 2 },
  // same outcome only, different difference (1)
  { label: "same outcome home win", p: [3, 0], r: [2, 1], expected: 1 },
  { label: "same outcome away win", p: [0, 3], r: [1, 2], expected: 1 },
  { label: "same outcome home win wide", p: [4, 1], r: [1, 0], expected: 1 },
  // wrong outcome (0)
  { label: "wrong home pred away result", p: [2, 0], r: [0, 2], expected: 0 },
  { label: "wrong draw pred home result", p: [1, 1], r: [2, 1], expected: 0 },
  { label: "wrong home pred draw result", p: [2, 1], r: [1, 1], expected: 0 },
  { label: "wrong away pred draw result", p: [0, 1], r: [2, 2], expected: 0 },
  { label: "wrong draw pred away result", p: [1, 1], r: [0, 1], expected: 0 },
  { label: "wrong away pred home result", p: [1, 2], r: [2, 1], expected: 0 },
  // 0..99 boundary cases (G3): prove the rule holds at the top of the domain.
  // Expected values derived from prd.md:113,129-133 (the FR-018 spec), not from
  // score_prediction's body.
  { label: "exact upper-bound home win", p: [99, 0], r: [99, 0], expected: 3 },
  { label: "exact upper-bound draw", p: [99, 99], r: [99, 99], expected: 3 },
  { label: "same diff near upper bound", p: [5, 0], r: [99, 94], expected: 2 },
  { label: "same outcome near upper bound", p: [99, 0], r: [1, 0], expected: 1 },
  { label: "wrong at upper bound (away vs home)", p: [0, 99], r: [99, 0], expected: 0 },
];

describe.skipIf(!dbConfigured)("results & scoring (live DB)", () => {
  let service: SupabaseClient<Database>;
  let admin: SupabaseClient<Database>;
  let participant: SupabaseClient<Database>;

  let tournamentId: string;
  let match1Id: string; // leaderboard match, result 2-1 (home win)
  let match2Id: string; // leaderboard match, result 0-2 (away win)
  let adminPastMatchId: string; // past, no seeded result — admin upsert target
  let futureMatchId: string; // future — write-guard target
  let recomputeMatchId: string; // past, dedicated to the correction → recompute test (G1)

  const userIds: string[] = [];
  let alphaId: string;
  let bravoId: string;
  let charlieId: string;
  let deltaId: string;
  let echoId: string; // dedicated predictor for the recompute test (G1) — outside [alpha…delta]
  let aliceId: string; // case-tie test (G2/G4): lower-case name
  let bobId: string; // case-tie test (G2/G4): upper-case name; inverts under a raw byte sort

  // Direct Postgres client: PostgREST cannot express `order by lower(display_name)`,
  // so the case-insensitive tie-break (G4) is read with explicit SQL ordering. Opened
  // in beforeAll, closed in afterAll — both inside the dbConfigured-gated describe.
  let dbClient: pg.Client | undefined;

  /**
   * Return every participant_id in the VIEW's own ranking order. This is a bare
   * top-level select from the view with NO WHERE and NO outer ORDER BY, so the
   * view's definition ORDER BY (the FR-020 tie-break) is what orders the rows —
   * the same way production reads it (`leaderboard/index.astro` selects with no
   * `.order()`). The assertion must prove the view's `lower(display_name)`
   * tie-break, so the helper must NOT impose its own order: an explicit
   * `order by lower(...)` would pass even against a broken view, and a
   * WHERE-filtered select does not reliably preserve the view's order (the
   * planner may return heap order). Mutating the view's tie-break to a
   * case-sensitive byte order (`display_name collate "C"`) flips the alice/Bob
   * order here — which is the point. (Plain `order by display_name` would NOT,
   * because the DB's en_US.UTF-8 collation already orders case-insensitively;
   * the `lower()` defends a case-sensitive collation, and "C" simulates one.)
   *
   * Uses raw `pg` rather than supabase-js because PostgREST cannot express the
   * `lower(display_name)` key and the implicit-order reliance is exactly what
   * this test pins (G4); the connection is the DB the suite already targets.
   */
  async function leaderboardOrder(): Promise<string[]> {
    if (!dbClient) throw new Error("pg client not connected");
    const { rows } = await dbClient.query<{ participant_id: string }>(`select participant_id from public.leaderboard`);
    return rows.map((row) => row.participant_id);
  }

  async function createParticipant(displayName: string): Promise<string> {
    const email = `rls-lb-${displayName}-${STAMP}@betcup.local`;
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

  async function seedResult(matchId: string, home: number, away: number): Promise<void> {
    const res = await service.from("match_results").insert({ match_id: matchId, home_score: home, away_score: away });
    if (res.error) throw new Error(`seed result failed: ${res.error.message}`);
  }

  async function seedPrediction(predictorId: string, matchId: string, home: number, away: number): Promise<void> {
    const res = await service
      .from("predictions")
      .insert({ predictor_id: predictorId, match_id: matchId, home_goals: home, away_goals: away });
    if (res.error) throw new Error(`seed prediction failed: ${res.error.message}`);
  }

  beforeAll(async () => {
    service = freshClient(SERVICE_ROLE_KEY);

    // Display names control the alphabetical tie-break; the leading a/b/c/d
    // letters fix lower(display_name) ordering deterministically.
    alphaId = await createParticipant("a-alpha");
    bravoId = await createParticipant("b-bravo");
    charlieId = await createParticipant("c-charlie");
    deltaId = await createParticipant("d-delta");

    // Dedicated participant for the recompute test (G1), outside the
    // [alpha…delta] standings filter so it can't perturb that assertion.
    echoId = await createParticipant("e-echo");

    // Case-only tie pair (G2/G4): "alice" (a=97) vs "Bob" (B=66). A raw byte
    // sort puts "Bob" first; lower() puts "alice" first. Seeded with identical
    // predictions so total_points and exact_scores tie, forcing the name fallback.
    aliceId = await createParticipant("alice");
    bobId = await createParticipant("Bob");

    admin = await signedInClient(ADMIN_EMAIL, ADMIN_PASSWORD);
    participant = await signedInClient(`rls-lb-a-alpha-${STAMP}@betcup.local`, PARTICIPANT_PASSWORD);

    const tour = await admin
      .from("tournaments")
      .insert({ name: "Scoring RLS Cup", time_zone: "Europe/Warsaw" })
      .select("id")
      .single();
    if (tour.error) throw new Error(`tournament insert failed: ${tour.error.message}`);
    tournamentId = tour.data.id;

    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    match1Id = await seedMatch(past, "M1 Home", "M1 Away");
    match2Id = await seedMatch(past, "M2 Home", "M2 Away");
    adminPastMatchId = await seedMatch(past, "Admin Past", "Match");
    futureMatchId = await seedMatch(future, "Future", "Match");
    recomputeMatchId = await seedMatch(past, "Recompute Home", "Recompute Away");

    // Results for the leaderboard matches (service-role bypasses RLS for setup).
    await seedResult(match1Id, 2, 1); // home win, diff +1
    await seedResult(match2Id, 0, 2); // away win, diff -2

    // Predictions producing the planned standings:
    //   Alpha   4 pts, 1 exact  (m1 exact 3, m2 same-outcome 1)
    //   Bravo   4 pts, 1 exact  (identical to Alpha — name decides vs Alpha)
    //   Charlie 4 pts, 0 exact  (m1 same-diff 2, m2 same-diff 2)
    //   Delta   0 pts           (no predictions — FR-019 completeness)
    await seedPrediction(alphaId, match1Id, 2, 1);
    await seedPrediction(alphaId, match2Id, 0, 1);
    await seedPrediction(bravoId, match1Id, 2, 1);
    await seedPrediction(bravoId, match2Id, 0, 1);
    await seedPrediction(charlieId, match1Id, 3, 2);
    await seedPrediction(charlieId, match2Id, 1, 3);

    // Recompute predictor (G1): predicts the recompute match 2-1. The test seeds
    // the initial result (2-1 → exact) and corrects it (0-2 → wrong) itself, so
    // recomputeMatchId stays result-less here.
    await seedPrediction(echoId, recomputeMatchId, 2, 1);

    // Case-tie pair (G2/G4): identical predictions → identical total_points (4)
    // and exact_scores (1), so only the case-insensitive name fallback can break
    // the tie. m1 (result 2-1): exact → 3. m2 (result 0-2): same outcome → 1.
    await seedPrediction(aliceId, match1Id, 2, 1);
    await seedPrediction(aliceId, match2Id, 0, 1);
    await seedPrediction(bobId, match1Id, 2, 1);
    await seedPrediction(bobId, match2Id, 0, 1);

    // Direct Postgres connection for the explicit lower()-ordered tie-break read.
    // Local stack uses no SSL; SUPABASE_DB_URL is the same sentinel the skip gate checks.
    dbClient = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL });
    await dbClient.connect();
  });

  afterAll(async () => {
    if (dbClient) await dbClient.end();
    if (tournamentId) await service.from("tournaments").delete().eq("id", tournamentId);
    for (const id of userIds) await service.auth.admin.deleteUser(id);
  });

  // 1. FR-018 grid ---------------------------------------------------------

  it.each(SCORING_GRID)("scores $label as $expected", async ({ p, r, expected }) => {
    const { data, error } = await service.rpc("score_prediction", {
      p_home: p[0],
      p_away: p[1],
      r_home: r[0],
      r_away: r[1],
    });
    expect(error).toBeNull();
    expect(data).toBe(expected);
  });

  // 1b. Result correction → recompute (G1, closes G6) ----------------------
  // Proves FR-010: after an admin corrects a result, the read-time views
  // (prediction_scores, leaderboard) reflect the new result on the next read,
  // with NO app-side recompute. "Row updated"/HTTP 200 is explicitly not enough.
  // Reads use the service client (both views are security_invoker) to remove
  // per-row RLS visibility as a variable. Initial result maps echo's 2-1
  // prediction to an EXACT (3) score; the correction flips it to WRONG (0), so a
  // frozen/broken recompute is detectable.

  it("recomputes prediction_scores and leaderboard after a result correction", async () => {
    // 1. Seed the initial result (2-1 → echo predicted 2-1 → exact, FR-018 = 3).
    await seedResult(recomputeMatchId, 2, 1);

    const initialScore = await service
      .from("prediction_scores")
      .select("points")
      .eq("predictor_id", echoId)
      .eq("match_id", recomputeMatchId)
      .single();
    expect(initialScore.error).toBeNull();
    expect(initialScore.data?.points).toBe(3);

    const initialBoard = await service
      .from("leaderboard")
      .select("total_points, exact_scores")
      .eq("participant_id", echoId)
      .single();
    expect(initialBoard.error).toBeNull();
    expect(initialBoard.data).toMatchObject({ total_points: 3, exact_scores: 1 });

    // 2. Correct the result via the production upsert shape (admin, onConflict).
    //    0-2 → echo predicted 2-1 (home win) vs away win → WRONG, FR-018 = 0.
    const correction = await admin
      .from("match_results")
      .upsert({ match_id: recomputeMatchId, home_score: 0, away_score: 2 }, { onConflict: "match_id" })
      .select("id");
    expect(correction.error).toBeNull();
    expect(correction.data).toHaveLength(1);

    // 3. Re-read: both views must reflect the corrected result with no app step.
    const correctedScore = await service
      .from("prediction_scores")
      .select("points")
      .eq("predictor_id", echoId)
      .eq("match_id", recomputeMatchId)
      .single();
    expect(correctedScore.error).toBeNull();
    expect(correctedScore.data?.points).toBe(0);

    const correctedBoard = await service
      .from("leaderboard")
      .select("total_points, exact_scores")
      .eq("participant_id", echoId)
      .single();
    expect(correctedBoard.error).toBeNull();
    expect(correctedBoard.data).toMatchObject({ total_points: 0, exact_scores: 0 });
  });

  // 2. Leaderboard ordering + completeness ---------------------------------

  it("ranks participants by total → exact-score count → name, with non-predictors at 0", async () => {
    const { data, error } = await participant
      .from("leaderboard")
      .select("participant_id, display_name, total_points, exact_scores");

    expect(error).toBeNull();
    expect(data).not.toBeNull();

    const mine = (data ?? []).filter((row) => [alphaId, bravoId, charlieId, deltaId].includes(row.participant_id));
    // View is ORDER BY'd; filtering preserves relative order.
    expect(mine.map((row) => row.participant_id)).toEqual([alphaId, bravoId, charlieId, deltaId]);

    const byId = new Map(mine.map((row) => [row.participant_id, row]));
    expect(byId.get(alphaId)).toMatchObject({ total_points: 4, exact_scores: 1 });
    expect(byId.get(bravoId)).toMatchObject({ total_points: 4, exact_scores: 1 });
    expect(byId.get(charlieId)).toMatchObject({ total_points: 4, exact_scores: 0 });
    expect(byId.get(deltaId)).toMatchObject({ total_points: 0, exact_scores: 0 });
  });

  // 2b. Case-insensitive name tie-break (G2, G4) ---------------------------
  // Proves FR-020's final fallback is case-INSENSITIVE, not a case-sensitive
  // byte ordering. "alice"/"Bob" tie on total_points (4) and exact_scores (1),
  // so only the name key decides. Under a case-sensitive byte sort (collate "C")
  // "Bob" (B=66) precedes "alice" (a=97); the view's `lower(display_name)` (and
  // the DB's en_US.UTF-8 dictionary collation) put "alice" first. Read in the
  // VIEW's own order over a raw pg connection, so the returned order reflects —
  // and therefore proves — the view's case-insensitive tie-break. (Mutating the
  // view to `display_name collate "C"` fails this; `lower()` passes it.)

  it("breaks a name tie case-insensitively (alice before Bob)", async () => {
    const order = await leaderboardOrder();
    const aliceRank = order.indexOf(aliceId);
    const bobRank = order.indexOf(bobId);
    expect(aliceRank).toBeGreaterThanOrEqual(0);
    expect(bobRank).toBeGreaterThanOrEqual(0);
    expect(aliceRank).toBeLessThan(bobRank);
  });

  // 3. match_results write RLS --------------------------------------------

  it("lets the admin upsert a result on a kicked-off match (1 row)", async () => {
    const { data, error } = await admin
      .from("match_results")
      .upsert({ match_id: adminPastMatchId, home_score: 3, away_score: 0 }, { onConflict: "match_id" })
      .select("id");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });

  it("lets the admin correct an existing result via upsert (still 1 row)", async () => {
    const { data, error } = await admin
      .from("match_results")
      .upsert({ match_id: adminPastMatchId, home_score: 1, away_score: 1 }, { onConflict: "match_id" })
      .select("id, home_score, away_score");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]).toMatchObject({ home_score: 1, away_score: 1 });
  });

  it("denies a participant inserting a result (RLS WITH CHECK — not admin)", async () => {
    const { error } = await participant
      .from("match_results")
      .insert({ match_id: match1Id, home_score: 5, away_score: 5 })
      .select("id");

    expect(error).not.toBeNull();
  });

  it("denies the admin inserting a result on a not-kicked-off match (match_is_kicked_off guard)", async () => {
    const { error } = await admin
      .from("match_results")
      .insert({ match_id: futureMatchId, home_score: 1, away_score: 0 })
      .select("id");

    expect(error).not.toBeNull();
  });

  it("exposes results to any authenticated user (public read)", async () => {
    const { data, error } = await participant
      .from("match_results")
      .select("home_score, away_score")
      .eq("match_id", match1Id);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]).toEqual({ home_score: 2, away_score: 1 });
  });
});
