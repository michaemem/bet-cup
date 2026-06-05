/**
 * Live-DB test for S-05 (participant match history) — the history READ path.
 *
 * Two things are pinned against a REAL local Supabase stack (`npx supabase
 * start`), because both ride on Postgres RLS + the prediction_scores/leaderboard
 * views, not the client:
 *
 *   1. CONSISTENCY (centerpiece — the roadmap's named top risk for S-05): a
 *      participant's history total equals their leaderboard total. Asserted both
 *      through the real `loadHistory` loader and directly against the
 *      prediction_scores view, viewed from ANOTHER participant's session.
 *   2. BLINDNESS smoke (thin — the predictions SELECT policy is exhaustively
 *      proven by predictions.rls.test.ts; this only checks the history read
 *      path): prediction_scores filtered to B returns zero rows for a future
 *      match, and `loadHistory(A, B)` never surfaces a pre-kickoff match B/A
 *      predicted. The loader's predictor_id filter gives this test its teeth —
 *      drop it and A's own future prediction leaks into B's history (4.6).
 *
 * Self-skips unless the DB URL AND both keys are set, so default `npm test`
 * skips it. Run locally:
 *
 *   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_ANON_KEY=<Publishable key> \
 *   SUPABASE_SERVICE_ROLE_KEY=<Secret key> \
 *   npm test -- history.rls
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/database.types";
import { loadHistory } from "@/lib/history";

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

describe.skipIf(!dbConfigured)("history read path — consistency + blindness (live DB)", () => {
  let service: SupabaseClient<Database>;
  let admin: SupabaseClient<Database>;
  let participantA: SupabaseClient<Database>;

  let tournamentId: string;
  let pastMatchId: string; // kicked off, has a result + B's exact prediction
  let futureMatchId: string; // not kicked off — A predicts it (blindness teeth)

  const userIds: string[] = [];
  let aUserId: string;
  let bUserId: string;

  async function createParticipant(displayName: string): Promise<string> {
    const email = `rls-hist-${displayName}-${STAMP}@betcup.local`;
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

    aUserId = await createParticipant("a-viewer");
    bUserId = await createParticipant("b-target");

    admin = await signedInClient(ADMIN_EMAIL, ADMIN_PASSWORD);
    participantA = await signedInClient(`rls-hist-a-viewer-${STAMP}@betcup.local`, PARTICIPANT_PASSWORD);

    const tour = await admin
      .from("tournaments")
      .insert({ name: "History RLS Cup", time_zone: ZONE })
      .select("id")
      .single();
    if (tour.error) throw new Error(`tournament insert failed: ${tour.error.message}`);
    tournamentId = tour.data.id;

    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    pastMatchId = await seedMatch(past, "Past Home", "Past Away");
    futureMatchId = await seedMatch(future, "Future Home", "Future Away");

    // B's exact prediction on the resulted past match → 3 pts (the only points B
    // earns). Seeded via service-role because the INSERT policy refuses a
    // post-kickoff write — we need the row to exist to score it.
    await seedResult(pastMatchId, 2, 1);
    await seedPrediction(bUserId, pastMatchId, 2, 1);

    // A predicts the FUTURE match through A's own session (real INSERT path).
    // This is the blindness teeth: with loadHistory's predictor_id filter intact,
    // it never appears in B's history; drop the filter and A's own future pick
    // leaks into loadHistory(A, B).
    const aFuture = await participantA
      .from("predictions")
      .insert({ predictor_id: aUserId, match_id: futureMatchId, home_goals: 1, away_goals: 0 })
      .select("id");
    if (aFuture.error) throw new Error(`A future prediction insert failed: ${aFuture.error.message}`);
  });

  afterAll(async () => {
    if (tournamentId) await service.from("tournaments").delete().eq("id", tournamentId);
    for (const id of userIds) await service.auth.admin.deleteUser(id);
  });

  // 1. Consistency (centerpiece) ------------------------------------------

  it("B's history total equals B's leaderboard total (viewed via A's session)", async () => {
    const summary = await loadHistory(participantA, bUserId, ZONE);

    const { data: lb, error: lbError } = await participantA
      .from("leaderboard")
      .select("total_points")
      .eq("participant_id", bUserId)
      .single();
    expect(lbError).toBeNull();

    // B's only resulted prediction is the exact past match → 3 pts.
    expect(summary.totalPoints).toBe(3);
    expect(summary.totalPoints).toBe(lb?.total_points ?? 0);
  });

  it("sum(prediction_scores.points for B) equals B's leaderboard total (direct view check)", async () => {
    const { data: scores, error: scoresError } = await participantA
      .from("prediction_scores")
      .select("points")
      .eq("predictor_id", bUserId);
    expect(scoresError).toBeNull();

    const sum = (scores ?? []).reduce((acc, row) => acc + (row.points ?? 0), 0);

    const { data: lb, error: lbError } = await participantA
      .from("leaderboard")
      .select("total_points")
      .eq("participant_id", bUserId)
      .single();
    expect(lbError).toBeNull();
    expect(sum).toBe(lb?.total_points ?? 0);
  });

  // 2. Blindness smoke (thin) ---------------------------------------------

  it("prediction_scores returns zero rows for B on the future (unresulted) match", async () => {
    const { data, error } = await participantA
      .from("prediction_scores")
      .select("match_id")
      .eq("predictor_id", bUserId)
      .eq("match_id", futureMatchId);

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("loadHistory(A, B) never surfaces the future match (no pre-kickoff leak)", async () => {
    const summary = await loadHistory(participantA, bUserId, ZONE);
    const ids = summary.rows.map((row) => row.matchId);

    expect(ids).toContain(pastMatchId); // B's revealed, resulted prediction shows
    expect(ids).not.toContain(futureMatchId); // A's own future pick must not leak in
  });
});
