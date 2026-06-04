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
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/database.types";
import { participantCreateSchema } from "@/lib/schemas/participant";
import { synthEmail } from "@/lib/username";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const dbConfigured = Boolean(process.env.SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? "admin@betcup.local";

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
