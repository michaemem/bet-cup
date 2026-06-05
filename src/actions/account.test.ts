/**
 * Integration test for the `account` Actions (FR-003 + FR-023): change password
 * and change display name, both gated by current-password verification.
 *
 * Like `participants.test.ts`, it exercises the REAL handlers: `astro:actions`
 * and `astro:env/server` are virtual modules aliased to runtime stubs in
 * `vitest.config.ts`, so importing the `server` object resolves and `.handler`
 * is reachable.
 *
 * Unlike the participants harness (which passes only `{ locals: { profile } }`
 * and runs on the service-role client), the account handlers call
 * `sessionClient(context)` and mutate on an AUTHENTICATED SSR client under RLS.
 * So the harness builds a full `context`:
 *   - `locals.user = { id, email }` (the created user),
 *   - a `Request` whose `Cookie` header carries the `@supabase/ssr` auth-token
 *     cookie — produced by signing in on a throwaway server client backed by an
 *     in-memory jar, then serializing that jar (so we never hand-reconstruct the
 *     storage-key/chunk format), and
 *   - a minimal `AstroCookies` stub (`get`/`getAll`/`set`/`delete`).
 *
 * These cases hit a REAL local Supabase stack and self-skip unless the DB URL
 * AND both keys are set, so the default `npm test` / CI gate stays green. Run:
 *
 *   SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *   SUPABASE_URL=http://127.0.0.1:54321 \
 *   SUPABASE_ANON_KEY=<Publishable key> \
 *   SUPABASE_SERVICE_ROLE_KEY=<Secret key> \
 *   npm test -- account
 */
import { createServerClient, serializeCookieHeader } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/db/database.types";
import {
  changeDisplayNameSchema,
  changePasswordSchema,
  type ChangeDisplayNameInput,
  type ChangePasswordInput,
} from "@/lib/schemas/account";
import { synthEmail } from "@/lib/username";

const SUPABASE_URL = process.env.SUPABASE_URL ?? "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? "";
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

const dbConfigured = Boolean(process.env.SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY);

const { server } = await import("@/actions/index");

interface HandlerError {
  code: string;
  message: string;
  fields?: Record<string, string[]>;
}

interface AccountContext {
  locals: { user: { id: string; email: string } };
  request: Request;
  cookies: ReturnType<typeof cookieStub>;
}

type DisplayNameHandler = (input: ChangeDisplayNameInput, context: AccountContext) => Promise<{ ok: boolean }>;
type PasswordHandler = (input: ChangePasswordInput, context: AccountContext) => Promise<{ ok: boolean }>;

const changeDisplayName = (server.account.changeDisplayName as unknown as { handler: DisplayNameHandler }).handler;
const changePassword = (server.account.changePassword as unknown as { handler: PasswordHandler }).handler;

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

/** A throwaway anon client for verifying which password authenticates. */
function anonClient(): SupabaseClient<Database> {
  return createClient<Database>(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

describe.skipIf(!dbConfigured)("account actions (live DB)", () => {
  let service: SupabaseClient<Database>;
  const createdIds: string[] = [];

  beforeAll(() => {
    service = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await service.auth.admin.deleteUser(id);
    }
  });

  /** Create a user (trigger seeds the profile) and track it for cleanup. */
  async function createUser(username: string, displayName: string, password: string): Promise<string> {
    const { data, error } = await service.auth.admin.createUser({
      email: synthEmail(username),
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName, username },
    });
    if (error) throw error;
    createdIds.push(data.user.id);
    return data.user.id;
  }

  /**
   * Sign in on a server client backed by an in-memory cookie jar, then serialize
   * the jar into a `Cookie` header so the handler's own `createClient` reads a
   * genuine authenticated session — without us reconstructing the ssr cookie
   * format by hand.
   */
  async function authedContext(email: string, password: string): Promise<AccountContext> {
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
    // `createClient` only reads `request.headers.get("Cookie")`. We use a plain
    // headers stub rather than a real `Request`: under the happy-dom test
    // environment, `Cookie` is a forbidden header that the `Headers` class
    // strips, which would silently leave the handler's client unauthenticated.
    const request = {
      headers: { get: (name: string) => (name.toLowerCase() === "cookie" ? cookieHeader : null) },
    } as unknown as Request;

    return {
      locals: { user: { id: data.user.id, email: data.user.email ?? email } },
      request,
      cookies: cookieStub(),
    };
  }

  it("rejects a display-name change when the current password is wrong, and persists nothing", async () => {
    const username = `itest_acct_wrong_${Date.now().toString()}`;
    const id = await createUser(username, "Original Name", "correct-pass");
    const context = await authedContext(synthEmail(username), "correct-pass");

    let caught: HandlerError | null = null;
    try {
      await changeDisplayName(
        changeDisplayNameSchema.parse({ displayName: "Hacked Name", currentPassword: "wrong-pass" }),
        context,
      );
    } catch (error) {
      caught = error as HandlerError;
    }

    expect(caught).not.toBeNull();
    expect(caught?.code).toBe("BAD_REQUEST");
    expect(caught?.fields?.currentPassword).toEqual(["Current password is incorrect."]);

    const { data } = await service.from("profiles").select("display_name").eq("id", id).single();
    expect(data?.display_name).toBe("Original Name");
  });

  it("updates only display_name with the correct current password (username/legal_name untouched)", async () => {
    const username = `itest_acct_name_${Date.now().toString()}`;
    const id = await createUser(username, "Before Name", "right-pass");

    const before = await service.from("profiles").select("username, legal_name").eq("id", id).single();
    const context = await authedContext(synthEmail(username), "right-pass");

    const result = await changeDisplayName(
      changeDisplayNameSchema.parse({ displayName: "After Name", currentPassword: "right-pass" }),
      context,
    );
    expect(result.ok).toBe(true);

    const after = await service.from("profiles").select("display_name, username, legal_name").eq("id", id).single();
    expect(after.data?.display_name).toBe("After Name");
    expect(after.data?.username).toBe(before.data?.username);
    expect(after.data?.legal_name).toBe(before.data?.legal_name);
  });

  it("changes the password so the new one authenticates and the old one no longer does", async () => {
    const username = `itest_acct_pw_${Date.now().toString()}`;
    await createUser(username, "PW User", "old-pass-1");
    const context = await authedContext(synthEmail(username), "old-pass-1");

    const result = await changePassword(
      changePasswordSchema.parse({
        currentPassword: "old-pass-1",
        newPassword: "new-pass-2",
        confirmPassword: "new-pass-2",
      }),
      context,
    );
    expect(result.ok).toBe(true);

    const newSignIn = await anonClient().auth.signInWithPassword({
      email: synthEmail(username),
      password: "new-pass-2",
    });
    expect(newSignIn.error).toBeNull();

    const oldSignIn = await anonClient().auth.signInWithPassword({
      email: synthEmail(username),
      password: "old-pass-1",
    });
    expect(oldSignIn.error).not.toBeNull();
  });
});
