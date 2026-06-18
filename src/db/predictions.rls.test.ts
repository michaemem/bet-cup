/**
 * Live-DB RLS integration test for S-03 (predictions) — the FR-015/FR-017
 * blindness invariant and the FR-014 kickoff write-lock.
 *
 * RLS is enforced by Postgres, NOT the Supabase client, so this hits a REAL
 * local Supabase stack (`npx supabase start`) with per-role sessions. Unlike
 * `matches.rls.test.ts` it creates TWO participants (A and B) to prove that one
 * participant cannot read another's pre-kickoff prediction — and that the admin
 * cannot either (the admin is just a participant here, FR-017).
 *
 * Proven boundaries:
 *   (a) owner reads their own pre-kickoff prediction (1 row),
 *   (b) a second participant reading A's pre-kickoff prediction gets 0 rows,
 *   (c) the admin reading A's pre-kickoff prediction gets 0 rows (no exemption),
 *   (d) after kickoff every authenticated user can read the prediction,
 *   (e) the owner cannot write a prediction once the match has kicked off
 *       (INSERT denied, UPDATE filtered to zero rows), but can before,
 *   (f) one row per (predictor, match) — a duplicate INSERT conflicts.
 *
 * Self-skips unless the DB URL AND both keys are set, so default `npm test`
 * skips it. Run locally:
 *
 *   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_ANON_KEY=<Publishable key> \
 *   SUPABASE_SERVICE_ROLE_KEY=<Secret key> \
 *   npm test -- predictions.rls
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/database.types";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const dbConfigured = Boolean(process.env.SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@betcup.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "local-only";

const STAMP = Date.now().toString();
const PARTICIPANT_A_EMAIL = `rls-pred-a-${STAMP}@betcup.local`;
const PARTICIPANT_B_EMAIL = `rls-pred-b-${STAMP}@betcup.local`;
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!dbConfigured)("predictions RLS — blindness + write-lock (live DB)", () => {
  let service: SupabaseClient<Database>;
  let admin: SupabaseClient<Database>;
  let participantA: SupabaseClient<Database>;
  let participantB: SupabaseClient<Database>;
  let aUserId: string;
  let bUserId: string;
  let tournamentId: string;
  let futureMatchId: string;
  let pastMatchId: string;
  let pastMatchId2: string;

  beforeAll(async () => {
    service = freshClient(SERVICE_ROLE_KEY);

    const { data: createdA, error: aErr } = await service.auth.admin.createUser({
      email: PARTICIPANT_A_EMAIL,
      password: PARTICIPANT_PASSWORD,
      email_confirm: true,
    });
    if (aErr) throw new Error(`participant A create failed: ${aErr.message}`);
    aUserId = createdA.user.id;

    const { data: createdB, error: bErr } = await service.auth.admin.createUser({
      email: PARTICIPANT_B_EMAIL,
      password: PARTICIPANT_PASSWORD,
      email_confirm: true,
    });
    if (bErr) throw new Error(`participant B create failed: ${bErr.message}`);
    bUserId = createdB.user.id;

    admin = await signedInClient(ADMIN_EMAIL, ADMIN_PASSWORD);
    participantA = await signedInClient(PARTICIPANT_A_EMAIL, PARTICIPANT_PASSWORD);
    participantB = await signedInClient(PARTICIPANT_B_EMAIL, PARTICIPANT_PASSWORD);

    const tour = await admin
      .from("tournaments")
      .insert({ name: "Predictions RLS Cup", time_zone: "Europe/Warsaw" })
      .select("id")
      .single();
    if (tour.error) throw new Error(`tournament insert failed: ${tour.error.message}`);
    tournamentId = tour.data.id;

    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    futureMatchId = await seedMatch(future, "Future", "Match");
    pastMatchId = await seedMatch(past, "Past", "Match");
    pastMatchId2 = await seedMatch(past, "Past", "Two");

    // A predicts the FUTURE match through A's own session (the real INSERT path,
    // allowed because the match has not kicked off).
    const ownWrite = await participantA
      .from("predictions")
      .insert({ predictor_id: aUserId, match_id: futureMatchId, home_goals: 1, away_goals: 2 })
      .select("id");
    if (ownWrite.error) throw new Error(`A future prediction insert failed: ${ownWrite.error.message}`);

    // A's prediction on the PAST match is seeded via service-role (bypasses RLS):
    // the INSERT policy would correctly refuse it post-kickoff, but we need an
    // existing row to prove the post-kickoff REVEAL and the UPDATE lock.
    const seedPast = await service
      .from("predictions")
      .insert({ predictor_id: aUserId, match_id: pastMatchId, home_goals: 3, away_goals: 0 })
      .select("id");
    if (seedPast.error) throw new Error(`A past prediction seed failed: ${seedPast.error.message}`);
  });

  afterAll(async () => {
    if (tournamentId) await service.from("tournaments").delete().eq("id", tournamentId);
    if (aUserId) await service.auth.admin.deleteUser(aUserId);
    if (bUserId) await service.auth.admin.deleteUser(bUserId);
  });

  /** Admin-seeds one match and returns its id. */
  async function seedMatch(kickoffIso: string, home: string, away: string): Promise<string> {
    const res = await admin
      .from("matches")
      .insert({ tournament_id: tournamentId, home_team: home, away_team: away, kickoff_time: kickoffIso })
      .select("id")
      .single();
    if (res.error) throw new Error(`seed match failed: ${res.error.message}`);
    return res.data.id;
  }

  it("lets the owner read their own pre-kickoff prediction (1 row)", async () => {
    const { data, error } = await participantA
      .from("predictions")
      .select("home_goals, away_goals")
      .eq("match_id", futureMatchId)
      .eq("predictor_id", aUserId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]).toEqual({ home_goals: 1, away_goals: 2 });
  });

  it("hides A's pre-kickoff prediction from a second participant (0 rows)", async () => {
    const { data, error } = await participantB
      .from("predictions")
      .select("id")
      .eq("match_id", futureMatchId)
      .eq("predictor_id", aUserId);

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("hides A's pre-kickoff prediction from the admin (0 rows — no admin exemption)", async () => {
    const { data, error } = await admin
      .from("predictions")
      .select("id")
      .eq("match_id", futureMatchId)
      .eq("predictor_id", aUserId);

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("reveals A's prediction to a second participant AFTER kickoff (1 row)", async () => {
    const { data, error } = await participantB
      .from("predictions")
      .select("home_goals, away_goals")
      .eq("match_id", pastMatchId)
      .eq("predictor_id", aUserId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]).toEqual({ home_goals: 3, away_goals: 0 });
  });

  it("reveals A's prediction to the admin AFTER kickoff (1 row)", async () => {
    const { data, error } = await admin
      .from("predictions")
      .select("home_goals, away_goals")
      .eq("match_id", pastMatchId)
      .eq("predictor_id", aUserId);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]).toEqual({ home_goals: 3, away_goals: 0 });
  });

  it("denies the owner inserting a prediction on a kicked-off match (RLS WITH CHECK)", async () => {
    const { error } = await participantA
      .from("predictions")
      .insert({ predictor_id: aUserId, match_id: pastMatchId2, home_goals: 5, away_goals: 5 })
      .select("id");

    // WITH CHECK (not match_is_kicked_off) is violated → RLS error (42501).
    expect(error).not.toBeNull();
  });

  it("denies the owner updating a prediction on a kicked-off match (RLS — zero rows)", async () => {
    const { data, error } = await participantA
      .from("predictions")
      .update({ home_goals: 9, away_goals: 9 })
      .eq("match_id", pastMatchId)
      .eq("predictor_id", aUserId)
      .select("id");

    // UPDATE USING (not match_is_kicked_off) filters the row out → zero rows.
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("lets the owner edit their prediction before kickoff (sanity — lock is not blanket)", async () => {
    const { data, error } = await participantA
      .from("predictions")
      .update({ home_goals: 4, away_goals: 4 })
      .eq("match_id", futureMatchId)
      .eq("predictor_id", aUserId)
      .select("home_goals, away_goals");

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]).toEqual({ home_goals: 4, away_goals: 4 });
  });

  it("enforces one prediction per (predictor, match) — duplicate insert conflicts", async () => {
    const { error } = await participantA
      .from("predictions")
      .insert({ predictor_id: aUserId, match_id: futureMatchId, home_goals: 0, away_goals: 0 })
      .select("id");

    // unique (predictor_id, match_id) → conflict (23505).
    expect(error).not.toBeNull();
  });

  // ── #3 Ownership / IDOR: B cannot author, mutate, or remove A's prediction ──

  it("denies B inserting a prediction spoofing A as the owner (RLS WITH CHECK)", async () => {
    const { error } = await participantB
      .from("predictions")
      .insert({ predictor_id: aUserId, match_id: futureMatchId, home_goals: 7, away_goals: 7 })
      .select("id");

    // WITH CHECK (predictor_id = auth.uid()) is violated — B is not A.
    expect(error).not.toBeNull();
  });

  it("blocks B from updating A's prediction (RLS USING — zero rows)", async () => {
    const { data, error } = await participantB
      .from("predictions")
      .update({ home_goals: 8, away_goals: 8 })
      .eq("match_id", futureMatchId)
      .eq("predictor_id", aUserId)
      .select("id");

    // UPDATE USING (predictor_id = auth.uid()) filters A's row out for B → zero rows.
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);

    // A's row is untouched (still readable by A with its own values).
    const owner = await participantA
      .from("predictions")
      .select("home_goals, away_goals")
      .eq("match_id", futureMatchId)
      .eq("predictor_id", aUserId);
    expect(owner.error).toBeNull();
    expect(owner.data).toHaveLength(1);
  });

  it("blocks B from deleting A's prediction (no DELETE policy — zero rows)", async () => {
    const { data, error } = await participantB
      .from("predictions")
      .delete()
      .eq("match_id", futureMatchId)
      .eq("predictor_id", aUserId)
      .select("id");

    // There is no DELETE policy, so USING matches nothing → zero rows affected, no error.
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);

    // A's row survives the delete attempt.
    const owner = await participantA
      .from("predictions")
      .select("id")
      .eq("match_id", futureMatchId)
      .eq("predictor_id", aUserId);
    expect(owner.error).toBeNull();
    expect(owner.data).toHaveLength(1);
  });

  // ── #1 Blindness edges: unfiltered list, anon denial, near-boundary crossing ──

  it("hides A's pre-kickoff prediction from B even without an owner filter (0 rows)", async () => {
    // Dropping the owner filter must not bypass blindness — only A has predicted
    // this future match, so a non-owner list query returns none of A's rows.
    const { data, error } = await participantB
      .from("predictions")
      .select("predictor_id, home_goals, away_goals")
      .eq("match_id", futureMatchId);

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);
  });

  it("denies an unauthenticated client any prediction rows (policy is to authenticated)", async () => {
    const anon = freshClient(ANON_KEY);
    const { data, error } = await anon.from("predictions").select("id").eq("match_id", futureMatchId);

    // No anon policy exists → default-denied; the anon role sees zero rows.
    expect(data ?? []).toHaveLength(0);
    expect(error ?? null).toBeNull();
  });

  it("flips A's prediction from blind to revealed for B as the match crosses kickoff", async () => {
    // Seed a dedicated match kicking off a few seconds out (hung off the existing
    // tournament so afterAll's cascade still cleans it up). A predicts it through
    // A's own session BEFORE kickoff (real INSERT path).
    const leadMs = 3000;
    const kickoffMs = Date.now() + leadMs;
    const boundaryMatchId = await seedMatch(new Date(kickoffMs).toISOString(), "Boundary", "Crossing");

    const aWrite = await participantA
      .from("predictions")
      .insert({ predictor_id: aUserId, match_id: boundaryMatchId, home_goals: 2, away_goals: 1 })
      .select("id");
    expect(aWrite.error).toBeNull();

    // Before kickoff: B is blind to A's prediction.
    const blind = await participantB
      .from("predictions")
      .select("home_goals, away_goals")
      .eq("match_id", boundaryMatchId)
      .eq("predictor_id", aUserId);
    expect(blind.error).toBeNull();
    expect(blind.data ?? []).toHaveLength(0);

    // Poll until Postgres' now() has crossed kickoff (robust to small clock skew
    // and avoids a single fixed sleep firing a hair early).
    const deadline = Date.now() + 15000;
    let revealed: { home_goals: number; away_goals: number }[] | null = null;
    while (Date.now() < deadline) {
      const { data } = await participantB
        .from("predictions")
        .select("home_goals, away_goals")
        .eq("match_id", boundaryMatchId)
        .eq("predictor_id", aUserId);
      if ((data ?? []).length === 1) {
        revealed = data;
        break;
      }
      await sleep(250);
    }

    // After kickoff: the same row is now visible to B with A's values.
    expect(revealed).not.toBeNull();
    expect(revealed).toHaveLength(1);
    expect(revealed?.[0]).toEqual({ home_goals: 2, away_goals: 1 });
  }, 20000);

  it("flips A's own write from allowed to locked as the match crosses kickoff", async () => {
    // Complements the SELECT-flip above: prove the WRITE-lock flips at the exact
    // Postgres-now() boundary. Seed a dedicated match a few seconds out (hung off
    // the existing tournament so afterAll's cascade cleans it up). A inserts a
    // prediction through A's OWN session BEFORE kickoff (real INSERT path).
    const leadMs = 3000;
    const kickoffMs = Date.now() + leadMs;
    const boundaryMatchId = await seedMatch(new Date(kickoffMs).toISOString(), "WriteFlip", "Boundary");

    const insert = await participantA
      .from("predictions")
      .insert({ predictor_id: aUserId, match_id: boundaryMatchId, home_goals: 1, away_goals: 1 })
      .select("id");
    // Pre-kickoff: the write is allowed.
    expect(insert.error).toBeNull();
    expect(insert.data ?? []).toHaveLength(1);

    // Sanity: an UPDATE pre-kickoff finds and edits A's row (1 row affected), so a
    // later zero-row result is the lock engaging — not a missing/never-writable row.
    const preEdit = await participantA
      .from("predictions")
      .update({ home_goals: 2, away_goals: 0 })
      .eq("match_id", boundaryMatchId)
      .eq("predictor_id", aUserId)
      .select("id");
    expect(preEdit.error).toBeNull();
    expect(preEdit.data ?? []).toHaveLength(1);

    // Poll the participant client until Postgres' now() has crossed kickoff and the
    // UPDATE USING (not match_is_kicked_off) filters A's row out → zero rows
    // (robust to small clock skew; never a single fixed sleep firing a hair early).
    const deadline = Date.now() + 15000;
    let locked = false;
    while (Date.now() < deadline) {
      const { data, error } = await participantA
        .from("predictions")
        .update({ home_goals: 9, away_goals: 9 })
        .eq("match_id", boundaryMatchId)
        .eq("predictor_id", aUserId)
        .select("id");
      // UPDATE never errors here — the policy filters, it does not raise.
      expect(error).toBeNull();
      if ((data ?? []).length === 0) {
        locked = true;
        break;
      }
      await sleep(250);
    }

    // After kickoff: A's own write is locked (the row is no longer reachable for UPDATE).
    expect(locked).toBe(true);
  }, 20000);
});

/**
 * #5 — Service-role blast radius (static, NO DB).
 *
 * This describe is deliberately NOT skip-gated: it must run in the default
 * `npm test` / `ci` job (no Supabase), because that is exactly the environment
 * where catching a new service-role importer matters most. The service-role key
 * BYPASSES RLS, so the whole blindness/ownership guarantee above collapses if a
 * second module starts reading the key or chains `.from("predictions")` onto the
 * admin client.
 *
 * Per lessons.md, we assert against PRODUCTION reads / importer count (raw source
 * under src/, excluding `*.test.*` and `test/`) — never a raw grep across src,
 * which catches test harnesses that reference the key NAME via `process.env`.
 */
describe("service-role isolation (static, no DB)", () => {
  const rawSources: Record<string, string> = import.meta.glob("/src/**/*.{ts,tsx,astro}", {
    query: "?raw",
    import: "default",
    eager: true,
  });

  const productionSources = Object.entries(rawSources)
    .map(([path, source]) => ({ path: path.replace(/^\//, ""), source }))
    .filter(({ path }) => !/\.test\.[tj]sx?$/.test(path) && !path.includes("/test/"));

  it("has exactly one production reader of SUPABASE_SERVICE_ROLE_KEY via astro:env/server", () => {
    const readers = productionSources
      .filter(({ source }) => /from\s+["']astro:env\/server["']/.test(source))
      .filter(({ source }) => source.includes("SUPABASE_SERVICE_ROLE_KEY"))
      .map(({ path }) => path)
      .sort();

    expect(readers).toEqual(["src/lib/supabase-admin.ts"]);
  });

  it("has exactly one production importer of the service-role client", () => {
    const importers = productionSources
      // Exclude the definition module itself — it declares createAdminAuthClient.
      .filter(({ path }) => path !== "src/lib/supabase-admin.ts")
      .filter(({ source }) => /@\/lib\/supabase-admin|createAdminAuthClient/.test(source))
      .map(({ path }) => path)
      .sort();

    expect(importers).toEqual(["src/actions/index.ts"]);
  });

  it("never touches a data table on the service-role client (auth-only, no .from())", () => {
    const adminModule = productionSources.find(({ path }) => path === "src/lib/supabase-admin.ts");
    expect(adminModule).toBeDefined();
    const adminSource = adminModule?.source ?? "";

    // The most dangerous regression: reading predictions on the RLS-bypassing client.
    expect(/\.from\(\s*["']predictions["']\s*\)/.test(adminSource)).toBe(false);
    // Stronger guard: the module is auth-only, so it touches no data table at all.
    expect(adminSource.includes(".from(")).toBe(false);
    // It must not issue RPCs either: the revoke_user_sessions RPC (S-09) is called
    // from actions/index.ts, NOT this module — keep the admin client auth-only so a
    // future SECURITY DEFINER call can't quietly turn it into a data-touching path.
    expect(adminSource.includes(".rpc(")).toBe(false);
  });
});
