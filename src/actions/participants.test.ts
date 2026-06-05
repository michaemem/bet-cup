/**
 * Integration test for S-01 `participants.create` (FR-001 + FR-002).
 *
 * It exercises the REAL Action handler (not a copy): `astro:actions` and
 * `astro:env/server` are virtual modules unresolvable outside the Astro build,
 * so they're stubbed here — `defineAction` is reduced to `(cfg) => cfg` purely to
 * reach `.handler`, and `astro:env/server` is mapped onto `process.env` so the
 * service-role client points at the local stack. Everything else (the schema,
 * the password generator, the synthetic-email mapping, the GoTrue call, the
 * `handle_new_user` trigger) is the real code path.
 *
 * Two lanes:
 *   - The admin-guard case is mockable and runs ALWAYS (incl. CI) — it throws
 *     before any DB call.
 *   - The create->login and duplicate cases hit a REAL local Supabase stack and
 *     self-skip unless the DB URL AND both keys are set, so the default
 *     `npm test` / CI gate stays green without a Supabase service. Run locally:
 *
 *       SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *       SUPABASE_URL=http://127.0.0.1:54321 \
 *       SUPABASE_ANON_KEY=<Publishable key> \
 *       SUPABASE_SERVICE_ROLE_KEY=<Secret key> \
 *       npm test -- participants
 *
 * Keys come from `npx supabase status` ("Publishable" = anon, "Secret" =
 * service_role). The admin defaults to the local seed (`admin@betcup.local` /
 * `local-only`); local email login must be enabled in config.toml.
 */
import { createServerClient, serializeCookieHeader } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/database.types";
import { participantCreateSchema, participantDeleteSchema } from "@/lib/schemas/participant";
import { synthEmail } from "@/lib/username";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const dbConfigured = Boolean(process.env.SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@betcup.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "local-only";

// `astro:actions` (ActionError + identity `defineAction`) and `astro:env/server`
// are aliased to runtime stubs in vitest.config.ts, so importing the real
// `server` object below resolves cleanly and the config's `.handler` is reachable.
const { server } = await import("@/actions/index");

interface HandlerError {
  code: string;
  message: string;
  fields?: Record<string, string[]>;
}

// The public `ActionClient` type doesn't expose `.handler`, but the mocked
// `defineAction` (identity) means the config object — including `handler` — is
// exactly what's stored. Reach it through a narrow local contract.
type CreateHandler = (
  input: { name: string; username: string },
  context: { locals: { profile: { roles: string[] } | null } },
) => Promise<{ username: string; password: string }>;

const createHandler = (server.participants.create as unknown as { handler: CreateHandler }).handler;

// The delete handler runs `adminClient(context)`: it re-checks the admin role on
// `locals.profile` (clean UNAUTHORIZED) AND builds an SSR client from the request
// cookies whose RLS session must itself be the admin (so `user_roles_select` lets
// it read the target's roles). Reach `.handler` through the same narrow contract.
interface DeleteContext {
  locals: { profile: { roles: string[] } | null };
  request: Request;
  cookies: unknown;
}
type DeleteHandler = (input: { id: string }, context: DeleteContext) => Promise<{ ok: boolean }>;

const deleteHandler = (server.participants.delete as unknown as { handler: DeleteHandler }).handler;

/** Invoke the real handler with schema-validated input (mimics Astro's pipeline). */
async function create(roles: ("admin" | "participant")[], name: string, username: string) {
  const input = participantCreateSchema.parse({ name, username });
  return createHandler(input, { locals: { profile: { roles } } });
}

describe("participants.create admin guard (always runs)", () => {
  it("refuses a non-admin caller with UNAUTHORIZED (before any DB call)", async () => {
    await expect(create(["participant"], "Mallory", "mallory")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe("participants.delete admin guard (always runs)", () => {
  it("refuses a non-admin caller with UNAUTHORIZED (before any DB call)", async () => {
    const input = participantDeleteSchema.parse({ id: "00000000-0000-4000-8000-000000000000" });
    // `requireAdmin` (inside `adminClient`) throws before any client is built or
    // any DB call is made, so the request/cookies here are never touched.
    await expect(
      deleteHandler(input, {
        locals: { profile: { roles: ["participant"] } },
        request: new Request("http://localhost/_actions/participants.delete"),
        cookies: {},
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("refuses a caller with no profile with UNAUTHORIZED (before any DB call)", async () => {
    const input = participantDeleteSchema.parse({ id: "00000000-0000-4000-8000-000000000000" });
    await expect(
      deleteHandler(input, {
        locals: { profile: null },
        request: new Request("http://localhost/_actions/participants.delete"),
        cookies: {},
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

describe.skipIf(!dbConfigured)("participants.create create->login + duplicate (live DB)", () => {
  // Built in beforeAll, not at describe-body eval: `skipIf` still evaluates the
  // body to collect tests, and `createClient` with an empty key throws.
  let service: SupabaseClient<Database>;
  const createdUsernames: string[] = [];

  function track(username: string) {
    createdUsernames.push(username);
  }

  beforeAll(() => {
    service = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  afterAll(async () => {
    for (const username of createdUsernames) {
      const { data } = await service.from("profiles").select("id").eq("username", username).maybeSingle();
      if (data?.id) await service.auth.admin.deleteUser(data.id);
    }
  });

  it("admin creates a participant who can then sign in with a participant-only role", async () => {
    const username = `itest_login_${Date.now().toString()}`;
    const result = await create(["admin", "participant"], "Bob Roberts", username);
    track(username);

    expect(result.username).toBe(username);
    expect(result.password.length).toBeGreaterThanOrEqual(12);

    // FR-002: the created participant signs in by their synthetic email.
    const anon = createClient<Database>(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error: signInError } = await anon.auth.signInWithPassword({
      email: synthEmail(username),
      password: result.password,
    });
    expect(signInError).toBeNull();

    // The trigger seeds participant-only — never a second admin.
    const { data: profile } = await service.from("profiles").select("id").eq("username", username).single();
    const { data: roleRows } = await service.from("user_roles").select("role").eq("user_id", profile.id);
    const roles = (roleRows ?? []).map((r) => r.role);
    expect(roles).toContain("participant");
    expect(roles).not.toContain("admin");
  });

  it("rejects a duplicate username with a friendly field error on `username`", async () => {
    const username = `itest_dup_${Date.now().toString()}`;
    await create(["admin", "participant"], "First", username);
    track(username);

    // Pins the GoTrue duplicate-email contract confirmed in Phase 2: a second
    // create must surface as a BAD_REQUEST input error on `username`, not the
    // generic 500 — so a future GoTrue change that alters the error shape fails
    // here instead of silently falling through.
    let caught: HandlerError | null = null;
    try {
      await create(["admin", "participant"], "Second", username);
    } catch (error) {
      caught = error as HandlerError;
    }
    expect(caught).not.toBeNull();
    expect(caught?.code).toBe("BAD_REQUEST");
    expect(caught?.fields?.username).toEqual(["That username is taken."]);
  });

  it("never mints a duplicate admin (sanity: the admin email is untouched)", async () => {
    const { data } = await service.from("profiles").select("username").eq("username", "admin").maybeSingle();
    expect(data?.username).toBe("admin");
    // The seeded admin still owns admin@betcup.local; creation only ever adds participants.
    expect(synthEmail("admin")).toBe(ADMIN_EMAIL);
  });
});

/** Minimal `AstroCookies` stub: collects `set` writes; ignores options. */
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

describe.skipIf(!dbConfigured)("participants.delete cascade + guard + idempotency (live DB)", () => {
  let service: SupabaseClient<Database>;
  const createdUsernames: string[] = [];
  let tournamentId: string | null = null;

  beforeAll(() => {
    service = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  afterAll(async () => {
    // Most created participants are deleted by the tests themselves; the lookup
    // no-ops on the already-gone ones. The tournament cascade clears any matches/
    // predictions/results seeded for the cascade case.
    for (const username of createdUsernames) {
      const { data } = await service.from("profiles").select("id").eq("username", username).maybeSingle();
      if (data?.id) await service.auth.admin.deleteUser(data.id);
    }
    if (tournamentId) await service.from("tournaments").delete().eq("id", tournamentId);
  });

  /**
   * Build a context whose SSR client is genuinely the admin: sign in on a server
   * client backed by an in-memory jar, then serialize the jar into a `Cookie`
   * header so the handler's own `adminClient` reads a real admin session (needed
   * for the RLS `user_roles_select` read) — without hand-reconstructing the ssr
   * cookie format. `locals.profile` carries the admin role for `requireAdmin`.
   */
  async function adminContext(): Promise<{ context: DeleteContext; adminId: string }> {
    const jar = new Map<string, string>();
    const authClient = createServerClient<Database>(SUPABASE_URL, ANON_KEY, {
      cookies: {
        getAll: () => [...jar.entries()].map(([name, value]) => ({ name, value })),
        setAll: (toSet) => {
          toSet.forEach(({ name, value }) => jar.set(name, value));
        },
      },
    });
    const { data, error } = await authClient.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
    if (error) throw error;

    const cookieHeader = [...jar.entries()].map(([name, value]) => serializeCookieHeader(name, value)).join("; ");
    // Mirror account.test.ts: under happy-dom, `Cookie` is a forbidden header the
    // `Headers` class strips, which would silently leave the client anonymous. A
    // plain headers stub avoids that — `createClient` only reads `get("Cookie")`.
    const request = {
      headers: { get: (name: string) => (name.toLowerCase() === "cookie" ? cookieHeader : null) },
    } as unknown as Request;

    return {
      context: { locals: { profile: { roles: ["admin"] } }, request, cookies: cookieStub() },
      adminId: data.user.id,
    };
  }

  /** Create a participant via the real `create` Action; return their profile id. */
  async function createParticipant(name: string, username: string): Promise<string> {
    await create(["admin", "participant"], name, username);
    createdUsernames.push(username);
    const { data, error } = await service.from("profiles").select("id").eq("username", username).single();
    if (error) throw error;
    return data.id;
  }

  it("hard-deletes the participant, cascades profile + predictions, and drops them from the leaderboard", async () => {
    const username = `itest_del_${Date.now().toString()}`;
    const id = await createParticipant("Casey Cascade", username);

    // Seed a tournament + a post-kickoff match, a prediction by the target, and a
    // result — so the participant has points and appears on the leaderboard.
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const tour = await service
      .from("tournaments")
      .insert({ name: `Delete Cup ${Date.now().toString()}`, time_zone: "Europe/Warsaw" })
      .select("id")
      .single();
    if (tour.error) throw tour.error;
    tournamentId = tour.data.id;

    const match = await service
      .from("matches")
      .insert({ tournament_id: tournamentId, home_team: "Home", away_team: "Away", kickoff_time: past })
      .select("id")
      .single();
    if (match.error) throw match.error;

    const pred = await service
      .from("predictions")
      .insert({ predictor_id: id, match_id: match.data.id, home_goals: 2, away_goals: 1 });
    if (pred.error) throw pred.error;

    const res = await service.from("match_results").insert({ match_id: match.data.id, home_score: 2, away_score: 1 });
    if (res.error) throw res.error;

    // Pre-condition: the participant is on the leaderboard before the delete.
    const before = await service.from("leaderboard").select("participant_id").eq("participant_id", id);
    expect(before.error).toBeNull();
    expect(before.data).toHaveLength(1);

    const { context } = await adminContext();
    const result = await deleteHandler(participantDeleteSchema.parse({ id }), context);
    expect(result).toEqual({ ok: true });

    // The `auth.users` row is gone — proving a HARD delete (a soft delete would
    // keep the row and the ON DELETE CASCADE to profiles/predictions wouldn't fire).
    const userLookup = await service.auth.admin.getUserById(id);
    expect(userLookup.data.user).toBeNull();

    // Profile, predictions, and leaderboard presence all cascade away.
    const profile = await service.from("profiles").select("id").eq("id", id).maybeSingle();
    expect(profile.data).toBeNull();

    const preds = await service.from("predictions").select("id").eq("predictor_id", id);
    expect(preds.data).toEqual([]);

    const after = await service.from("leaderboard").select("participant_id").eq("participant_id", id);
    expect(after.data).toEqual([]);
  });

  it("refuses to delete an admin-role target with FORBIDDEN and leaves the admin intact", async () => {
    const { context, adminId } = await adminContext();
    await expect(deleteHandler(participantDeleteSchema.parse({ id: adminId }), context)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const stillThere = await service.from("profiles").select("id").eq("id", adminId).maybeSingle();
    expect(stillThere.data?.id).toBe(adminId);
  });

  it("treats deleting an already-removed id as idempotent success", async () => {
    const username = `itest_del_idem_${Date.now().toString()}`;
    const id = await createParticipant("Ida Idempotent", username);

    const { context } = await adminContext();
    expect(await deleteHandler(participantDeleteSchema.parse({ id }), context)).toEqual({ ok: true });
    // Second delete of the now-removed id: zero role rows ⇒ early idempotent `{ ok: true }`.
    expect(await deleteHandler(participantDeleteSchema.parse({ id }), context)).toEqual({ ok: true });
  });
});
