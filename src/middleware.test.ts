import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "@/types";

// Hoisted mock fns so the `vi.mock` factory can reference them. Mocking
// `@/lib/supabase` also stops the real module (and its `astro:env/server`
// import) from loading in the test environment.
const { mockCreateClient, mockLoadProfile } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(),
  mockLoadProfile: vi.fn<(supabase: unknown, userId: string) => Promise<Profile | null>>(),
}));

vi.mock("@/lib/supabase", () => ({
  createClient: mockCreateClient,
  loadProfile: mockLoadProfile,
}));

const { onRequest } = await import("@/middleware");

interface SupabaseUser {
  id: string;
}

/** A minimal supabase client whose `auth.getUser()` resolves to the given user. */
function fakeClient(user: SupabaseUser | null) {
  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user } }),
    },
  };
}

/** Build a minimal APIContext-shaped object the middleware actually touches. */
function mockAstroContext(pathname: string) {
  const url = new URL(`http://localhost${pathname}`);
  const locals: App.Locals = { user: null, profile: null };
  const context = {
    request: new Request(url),
    cookies: {},
    url,
    locals,
    redirect: (path: string, status = 302) => new Response(null, { status, headers: { Location: path } }),
  };
  return context as unknown as APIContext;
}

function run(pathname: string) {
  const context = mockAstroContext(pathname);
  const next = vi.fn(() => Promise.resolve(new Response("ok", { status: 200 })));
  const result = onRequest(context, next) as Promise<Response>;
  return { context, next, result };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("middleware default-deny gate", () => {
  it("redirects an unauthed visit to a private path to /auth/signin (302)", async () => {
    mockCreateClient.mockReturnValue(fakeClient(null));
    const { next, result } = run("/predictions");
    const response = await result;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/auth/signin");
    expect(next).not.toHaveBeenCalled();
  });

  it("lets an unauthed visit to /auth/signin pass through (200)", async () => {
    mockCreateClient.mockReturnValue(fakeClient(null));
    const { next, result } = run("/auth/signin");
    const response = await result;

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("lets an authed visit to /dashboard pass through", async () => {
    mockCreateClient.mockReturnValue(fakeClient({ id: "u1" }));
    mockLoadProfile.mockResolvedValue({ id: "u1", displayName: "Admin", roles: ["participant", "admin"] });
    const { next, result } = run("/dashboard");
    const response = await result;

    expect(next).toHaveBeenCalledOnce();
    expect(response.status).toBe(200);
  });

  it("redirects an authed visit to /auth/signin to /dashboard (302)", async () => {
    mockCreateClient.mockReturnValue(fakeClient({ id: "u1" }));
    mockLoadProfile.mockResolvedValue({ id: "u1", displayName: "Admin", roles: ["participant", "admin"] });
    const { next, result } = run("/auth/signin");
    const response = await result;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/dashboard");
    expect(next).not.toHaveBeenCalled();
  });

  it("populates locals.profile from loadProfile for an authed request", async () => {
    mockCreateClient.mockReturnValue(fakeClient({ id: "u1" }));
    mockLoadProfile.mockResolvedValue({ id: "u1", displayName: "Admin", roles: ["participant", "admin"] });
    const { context, result } = run("/dashboard");
    await result;

    expect(context.locals.user).not.toBeNull();
    expect(context.locals.profile?.displayName).toBe("Admin");
    expect(context.locals.profile?.roles).toEqual(["participant", "admin"]);
  });

  it("sets locals.user and locals.profile to null for an unauthed request", async () => {
    mockCreateClient.mockReturnValue(fakeClient(null));
    const { context, result } = run("/");
    await result;

    expect(context.locals.user).toBeNull();
    expect(context.locals.profile).toBeNull();
    expect(mockLoadProfile).not.toHaveBeenCalled();
  });
});
