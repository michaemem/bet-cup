/**
 * Integration test for the `predictions.upsert` Action (FR-011–FR-014) — the
 * action-layer surface that sits on top of the predictions RLS policies.
 *
 * Like `account.test.ts`, it exercises the REAL handler: `astro:actions` and
 * `astro:env/server` are virtual modules aliased to runtime stubs in
 * `vitest.config.ts`, so importing the `server` object resolves and `.handler`
 * is reachable. The handler runs on a SESSION client (anon key + the caller's
 * cookies), so RLS owns both the blindness invariant and the kickoff write-lock.
 *
 * Two lanes:
 *   - an ALWAYS-runs guard (unauthenticated caller → UNAUTHORIZED before any DB
 *     call), so it stays in the default `npm test` / CI gate with no Supabase;
 *   - a live-DB lane (`describe.skipIf(!dbConfigured)`) proving the action's own
 *     translation on top of RLS: the friendly NOT_FOUND vs FORBIDDEN
 *     discrimination, the zero-row→FORBIDDEN kickoff lock, and that a participant
 *     can only ever write their OWN row (#3 — ownership is structural; the input
 *     schema has no owner channel, so `predictor_id` is always the session
 *     identity). It does NOT re-prove the raw RLS policies — those are pinned by
 *     `src/db/predictions.rls.test.ts`.
 *
 * Assertions check the error CODE + which branch fired (NOT_FOUND vs FORBIDDEN),
 * never message text (UX, not contract) and never Postgres `error.code`.
 *
 * NO `@vitest-environment` pragma — stays on the global happy-dom env (which
 * provides WebSocket); supabase-js 2.105.3 throws on client init under the node
 * env (test-plan §6.6). The live cases hit a REAL local stack and self-skip
 * unless the DB URL AND both keys are set, so the default gate stays green. Run:
 *
 *   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_ANON_KEY=<Publishable key> \
 *   SUPABASE_SERVICE_ROLE_KEY=<Secret key> \
 *   npm test -- predictions
 */
import { createServerClient, serializeCookieHeader } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/database.types";
import { predictionUpsertSchema, type PredictionUpsertInput } from "@/lib/schemas/prediction";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const dbConfigured = Boolean(process.env.SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@betcup.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "local-only";

const STAMP = Date.now().toString();
const PARTICIPANT_A_EMAIL = `act-pred-a-${STAMP}@betcup.local`;
const PARTICIPANT_B_EMAIL = `act-pred-b-${STAMP}@betcup.local`;
const PARTICIPANT_PASSWORD = "participant-only";

// A well-formed uuid that matches no row — exercises the NOT_FOUND branch and
// the unauthenticated guard's schema-validated input.
const ABSENT_MATCH_ID = "00000000-0000-4000-8000-000000000000";

const { server } = await import("@/actions/index");

interface PredictionContext {
  locals: { user?: { id: string; email: string } };
  request: Request;
  cookies: ReturnType<typeof cookieStub>;
}

// The public `ActionClient` type doesn't expose `.handler`, but the stubbed
// `defineAction` (identity) means the config object — including `handler` — is
// exactly what's stored. Reach it through a narrow local contract.
type UpsertHandler = (input: PredictionUpsertInput, context: PredictionContext) => Promise<{ id: string }>;

const upsertHandler = (server.predictions.upsert as unknown as { handler: UpsertHandler }).handler;

/** Minimal `AstroCookies` stub: collects `set` writes; `set` ignores options. */
function cookieStub() {
  const store = new Map<string, string>();
  return {
    get: (name: string) => (store.has(name) ? { value: store.get(name) ?? "" } : undefined),
    getAll: () => [...store.entries()].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, _options?: unknown) => {
      store.set(name, value);
    },
    delete: (name: string) => {
      store.delete(name);
    },
    has: (name: string) => store.has(name),
  };
}

describe("predictions.upsert (always runs)", () => {
  it("refuses an unauthenticated caller with UNAUTHORIZED (before any DB call)", async () => {
    const input = predictionUpsertSchema.parse({ matchId: ABSENT_MATCH_ID, homeGoals: 1, awayGoals: 0 });
    await expect(
      upsertHandler(input, {
        locals: {},
        request: new Request("http://localhost/_actions/predictions.upsert"),
        cookies: cookieStub(),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe.skipIf(!dbConfigured)("predictions.upsert (live DB)", () => {
  let service: SupabaseClient<Database>;
  let admin: SupabaseClient<Database>;
  let aUserId: string;
  let bUserId: string;
  let tournamentId: string;
  let futureMatchId: string;
  let pastCreateMatchId: string;
  let pastEditMatchId: string;
  let ctxA: PredictionContext;
  let ctxB: PredictionContext;

  beforeAll(async () => {
    service = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const createdA = await service.auth.admin.createUser({
      email: PARTICIPANT_A_EMAIL,
      password: PARTICIPANT_PASSWORD,
      email_confirm: true,
    });
    if (createdA.error) throw new Error(`participant A create failed: ${createdA.error.message}`);
    aUserId = createdA.data.user.id;

    const createdB = await service.auth.admin.createUser({
      email: PARTICIPANT_B_EMAIL,
      password: PARTICIPANT_PASSWORD,
      email_confirm: true,
    });
    if (createdB.error) throw new Error(`participant B create failed: ${createdB.error.message}`);
    bUserId = createdB.data.user.id;

    // The admin session is needed only to seed the tournament + matches (RLS
    // requires is_admin() for those writes).
    admin = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const adminSignIn = await admin.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    if (adminSignIn.error) throw new Error(`admin sign-in failed: ${adminSignIn.error.message}`);

    const tour = await admin
      .from("tournaments")
      .insert({ name: "Predictions Action Cup", time_zone: "Europe/Warsaw" })
      .select("id")
      .single();
    if (tour.error) throw new Error(`tournament insert failed: ${tour.error.message}`);
    tournamentId = tour.data.id;

    const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    futureMatchId = await seedMatch(future, "Future", "Match");
    pastCreateMatchId = await seedMatch(past, "Past", "Create");
    pastEditMatchId = await seedMatch(past, "Past", "Edit");

    // A's prediction on the past EDIT match is seeded via service-role (bypasses
    // RLS): the INSERT policy would correctly refuse it post-kickoff, but we need
    // an existing row to prove the action rejects an EDIT once kicked off.
    const seedPast = await service
      .from("predictions")
      .insert({ predictor_id: aUserId, match_id: pastEditMatchId, home_goals: 3, away_goals: 0 })
      .select("id");
    if (seedPast.error) throw new Error(`A past prediction seed failed: ${seedPast.error.message}`);

    ctxA = await authedContext(PARTICIPANT_A_EMAIL, PARTICIPANT_PASSWORD);
    ctxB = await authedContext(PARTICIPANT_B_EMAIL, PARTICIPANT_PASSWORD);
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

  /**
   * Sign in on a server client backed by an in-memory cookie jar, then serialize
   * the jar into a `Cookie` header so the handler's own `createClient` reads a
   * genuine authenticated session — without us reconstructing the ssr cookie
   * format by hand (mirrors `account.test.ts`).
   */
  async function authedContext(email: string, password: string): Promise<PredictionContext> {
    const jar = new Map<string, string>();
    const authClient = createServerClient<Database>(SUPABASE_URL, ANON_KEY, {
      cookies: {
        getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => jar.set(name, value));
        },
      },
    });
    const { data, error } = await authClient.auth.signInWithPassword({ email, password });
    if (error) throw error;

    const cookieHeader = [...jar.entries()].map(([name, value]) => serializeCookieHeader(name, value)).join("; ");
    // `createClient` only reads `request.headers.get("Cookie")`. Under happy-dom,
    // `Cookie` is a forbidden header the `Headers` class strips, which would
    // silently leave the handler's client unauthenticated — so use a plain stub.
    const request = {
      headers: { get: (name: string) => (name.toLowerCase() === "cookie" ? cookieHeader : null) },
    } as unknown as Request;

    return {
      locals: { user: { id: data.user.id, email: data.user.email ?? email } },
      request,
      cookies: cookieStub(),
    };
  }

  const parse = (matchId: string, homeGoals: number, awayGoals: number): PredictionUpsertInput =>
    predictionUpsertSchema.parse({ matchId, homeGoals, awayGoals });

  it("creates the caller's own prediction before kickoff (predictor_id = session identity)", async () => {
    const created = await upsertHandler(parse(futureMatchId, 1, 2), ctxA);
    expect(created.id).toBeTruthy();

    // The action exposes no owner channel — the row is owned by A's session id.
    const { data, error } = await service
      .from("predictions")
      .select("predictor_id, home_goals, away_goals")
      .eq("id", created.id)
      .single();
    expect(error).toBeNull();
    expect(data?.predictor_id).toBe(aUserId);
    expect(data).toMatchObject({ home_goals: 1, away_goals: 2 });
  });

  it("edits the caller's prediction in place on a second upsert (one row per predictor,match)", async () => {
    const edited = await upsertHandler(parse(futureMatchId, 3, 0), ctxA);
    expect(edited.id).toBeTruthy();

    const { data, error } = await service
      .from("predictions")
      .select("id, home_goals, away_goals")
      .eq("predictor_id", aUserId)
      .eq("match_id", futureMatchId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    expect(data?.[0]).toMatchObject({ id: edited.id, home_goals: 3, away_goals: 0 });
  });

  it("rejects a CREATE after kickoff with FORBIDDEN (the lock branch)", async () => {
    await expect(upsertHandler(parse(pastCreateMatchId, 1, 1), ctxA)).rejects.toMatchObject({ code: "FORBIDDEN" });

    // Nothing was written for A on the locked match.
    const { data } = await service
      .from("predictions")
      .select("id")
      .eq("predictor_id", aUserId)
      .eq("match_id", pastCreateMatchId);
    expect(data ?? []).toHaveLength(0);
  });

  it("rejects an EDIT after kickoff with FORBIDDEN, leaving the existing row untouched", async () => {
    await expect(upsertHandler(parse(pastEditMatchId, 5, 5), ctxA)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const { data } = await service
      .from("predictions")
      .select("home_goals, away_goals")
      .eq("predictor_id", aUserId)
      .eq("match_id", pastEditMatchId)
      .single();
    expect(data).toMatchObject({ home_goals: 3, away_goals: 0 });
  });

  it("throws NOT_FOUND for an unknown match id (distinct from the lock branch)", async () => {
    await expect(upsertHandler(parse(ABSENT_MATCH_ID, 0, 0), ctxA)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("scopes the upsert to the caller — B writes B's own row and cannot touch A's (#3)", async () => {
    const aBefore = await service
      .from("predictions")
      .select("predictor_id, home_goals, away_goals")
      .eq("predictor_id", aUserId)
      .eq("match_id", futureMatchId)
      .single();
    expect(aBefore.error).toBeNull();

    const bCreated = await upsertHandler(parse(futureMatchId, 9, 8), ctxB);
    expect(bCreated.id).toBeTruthy();

    // B's write created B's OWN row, not a mutation of A's.
    const bRow = await service
      .from("predictions")
      .select("predictor_id, home_goals, away_goals")
      .eq("id", bCreated.id)
      .single();
    expect(bRow.data?.predictor_id).toBe(bUserId);
    expect(bRow.data).toMatchObject({ home_goals: 9, away_goals: 8 });

    // A's row for the same match is byte-for-byte unchanged.
    const aAfter = await service
      .from("predictions")
      .select("predictor_id, home_goals, away_goals")
      .eq("predictor_id", aUserId)
      .eq("match_id", futureMatchId)
      .single();
    expect(aAfter.data).toEqual(aBefore.data);
  });
});
