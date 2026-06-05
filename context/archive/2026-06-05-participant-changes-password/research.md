---
date: 2026-06-05T12:30:00+02:00
researcher: mimazu
git_commit: b1ee829b013c60388f3c12e59da5be0ec357d378
branch: feature/S-07_participant-changes-password
repository: braveai-prj
topic: "Authenticated participant changes their own password (S-07 / FR-003)"
tags: [research, codebase, auth, supabase, password, actions, middleware]
status: complete
last_updated: 2026-06-05
last_updated_by: mimazu
---

# Research: Authenticated participant changes their own password (S-07 / FR-003)

**Date**: 2026-06-05T12:30:00+02:00
**Researcher**: mimazu
**Git Commit**: b1ee829b013c60388f3c12e59da5be0ec357d378
**Branch**: feature/S-07_participant-changes-password
**Repository**: braveai-prj

## Research Question

How should we implement the authenticated "change my password" flow (FR-003 / roadmap S-07): a logged-in participant opens a settings page, enters their current password and a new password, confirms, and subsequent logins use the new password? Scope: **logged-in change only** (not lost-password/email reset). Depth: detailed — full architecture, Supabase APIs, session/cookie handling, edge cases, security.

## Summary

The foundation is fully in place; this is the lowest-risk slice on the roadmap and needs **no DB migration and no RLS changes** — it's a pure `auth.users` update via the per-request SSR session client.

Key conclusions:

- **Backend mechanism:** `supabase.auth.updateUser({ password })` on the session SSR client built by `createClient(context.request.headers, context.cookies)` (`src/lib/supabase.ts:8`). This method is **not yet used anywhere** in the codebase. Never use the service-role admin client for this.
- **Where it lives — a genuine fork.** Two established patterns collide here:
  - **Astro Actions** (`src/actions/index.ts`) + RHF + zod + shadcn — used by *every domain mutation*. `sessionClient()` (`src/actions/index.ts:89`) already gives an authed Supabase client and throws `UNAUTHORIZED` without a user.
  - **`src/pages/api/auth/*` native POST + redirect** — used by *the two auth cookie-bootstrap flows* (sign-in/sign-out).
  Password change is an authenticated mutation on an already-bootstrapped session, so the **Actions + RHF stack is the better fit** (and gives inline field errors via `isInputError`). No prior plan resolves this explicitly — it's the main design decision to make in `/10x-plan`.
- **Route is auto-protected.** Middleware is **default-deny** (`PUBLIC_ROUTES` allowlist at `src/middleware.ts:7`). A new `/settings` page and any new Action require **no middleware edit**.
- **Current-password verification is a product decision.** Local GoTrue has `secure_password_change = false` (`supabase/config.toml:215`), so Supabase will *not* enforce reauth. The roadmap outcome explicitly says the user "enters their current password" — so we must verify it ourselves (re-`signInWithPassword` with the synthetic email, or `auth.reauthenticate()`), since `updateUser` alone won't.
- **Other sessions stay valid.** `updateUser({ password })` does not revoke other devices' refresh tokens. If "log out everywhere" is desired, that's an explicit extra step (`signOut({ scope: 'others' })`) — and the roadmap does **not** require it.

## Detailed Findings

### Supabase SSR auth client (the mechanism)

`src/lib/supabase.ts` exposes `createClient(requestHeaders, cookies)` which wraps `@supabase/ssr` `createServerClient` with cookie bridging:

```8:26:src/lib/supabase.ts
export function createClient(requestHeaders: Headers, cookies: AstroCookies) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return null;
  }
  return createServerClient<Database>(SUPABASE_URL, SUPABASE_KEY, {
    cookies: {
      getAll() {
        return parseCookieHeader(requestHeaders.get("Cookie") ?? "").map(({ name, value }) => ({
          name,
          value: value ?? "",
        }));
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          cookies.set(name, value, options);
        });
      },
    },
  });
}
```

- Secrets come from `astro:env/server` (`src/lib/supabase.ts:4`) — `SUPABASE_KEY` is the anon/publishable key. Never use `import.meta.env.*` (AGENTS.md hard rule).
- Returns `null` when env is missing (graceful degradation — handle this branch).
- A **separate** service-role client exists (`src/lib/supabase-admin.ts:19`, `createAdminAuthClient`) used **only** for `auth.admin.createUser` from `src/actions/index.ts:146`. **Do not** use it for password change.
- Packages: `@supabase/ssr ^0.10.3`, `@supabase/supabase-js ^2.99.1` (`package.json:34-35`).

**Auth methods already in production:** `getUser()` (`src/middleware.ts:46`), `signInWithPassword()` (`src/pages/api/auth/signin.ts:35`), `signOut()` (`src/pages/api/auth/signout.ts:9`), `auth.admin.createUser()` (`src/actions/index.ts:146`). **Not used yet:** `updateUser`, `reauthenticate`, `resetPasswordForEmail`, `getSession`.

### How the authenticated user is resolved

Middleware validates the JWT server-side every request and populates `locals`:

```39:57:src/middleware.ts
export const onRequest = defineMiddleware(async (context, next) => {
  const supabase = createClient(context.request.headers, context.cookies);

  if (supabase) {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();
    // ...
    context.locals.user = user ?? null;
    context.locals.profile = user ? await loadProfile(supabase, user.id) : null;
  } else {
    context.locals.user = null;
    context.locals.profile = null;
  }
```

- Uses `getUser()` (validates JWT), **not** `getSession()`. Types: `App.Locals.user` is `@supabase/supabase-js` `User`, `profile` is `Profile` (`src/env.d.ts:1-6`, `src/types.ts:11-16`).
- The user's `email` (the synthetic `<username>@betcup.local` from S-01, see `src/lib/username.ts`) is on `locals.user.email` — needed if we verify the current password via `signInWithPassword`.

### Default-deny middleware (route is free)

```4:12:src/middleware.ts
// Default-deny gate (PRD `## Access Control`): every route is private unless its
// prefix is listed here. `/api/auth/signout` is public so the sign-out form can
// clear a session-clearing request without a refresh-token race.
const PUBLIC_ROUTES = ["/auth/signin", "/api/auth/signin", "/api/auth/signout"];

const ADMIN_ROUTES = ["/admin"];
```

A new `/settings` route (and any new Action endpoint) is **private by default** — no middleware change needed. Prefix matching is exact or `/`-bounded (guards against `/auth/signin-backdoor`-style collisions, tested in `src/middleware.test.ts:134-141`). `SECURITY_HEADERS` (incl. `form-action 'self'`, `connect-src https://*.supabase.co`) are applied to every response, redirects included (`src/middleware.ts:29-37,61-66`).

### Form & endpoint conventions (two patterns)

**Pattern A — Astro Actions (every domain mutation).** Defined in `src/actions/index.ts` via `defineAction`, called from React via `actions.*` + `isInputError`:

```27:46:src/components/admin/ParticipantForm.tsx
const form = useForm<ParticipantCreateInput>({
  resolver: zodResolver(participantCreateSchema),
  defaultValues: { name: "", username: "" },
});
const onSubmit = async (values: ParticipantCreateInput) => {
  setServerError(null);
  const { data, error } = await actions.participants.create(values);
  if (error) {
    if (isInputError(error)) {
      for (const [field, messages] of Object.entries(error.fields)) {
        form.setError(field as keyof ParticipantCreateInput, { message: messages[0] });
      }
    } else {
      setServerError(error.message);
    }
    return;
  }
```

Helpers already available in `src/actions/index.ts`: `requireAdmin()` (59), `sessionClient()` (89, returns authed client / throws `UNAUTHORIZED`), `inputError(field, message)` (50). Shared zod schemas live in `src/lib/schemas/<domain>.ts`.

**Pattern B — auth API route (cookie bootstrap only).** `src/pages/api/auth/signin.ts` and `signout.ts`: `export const prerender = false`, `formData()` → zod `safeParse` → Supabase SSR client → **redirect with `?error=`**. No JSON. This pattern is reserved for unauthenticated session entry/exit.

**Recommendation for S-07:** Pattern A (Actions + RHF + shadcn). It matches all in-session mutations, supports per-field inline errors, and `sessionClient()` already wires the authed client.

### Session/cookie behavior on password change

- `@supabase/ssr` re-writes auth cookies via the `setAll` callback on `USER_UPDATED` (among `SIGNED_IN`, `TOKEN_REFRESHED`, `SIGNED_OUT`, etc.). So after `updateUser({ password })`, the **current device stays logged in** with refreshed cookies automatically.
- Default cookie storage key is `supabase.auth.token` (chunked `.0`, `.1`…), `path:/`, `sameSite:lax`, `httpOnly:false`, ~400-day maxAge (project doesn't override).
- **Other sessions are NOT revoked** by a password change. Old password stops working for *new* sign-ins; existing sessions persist until token expiry/refresh failure. "Sign out everywhere" would need an explicit `signOut({ scope: 'others' })` step — not required by the roadmap outcome.
- Note: sign-out currently uses default **global** scope (`src/pages/api/auth/signout.ts:9`), revoking all devices — unrelated to change-password but worth knowing.

### Security / validation discipline (from prior reviews)

- **Never surface raw GoTrue errors** to the user; log server-side with `console.error`, show generic messages (S-01 impl-review F2; same discipline as `signin.ts:38`).
- **Client/server validation parity** — mirror the server zod rules on the client; sign-in uses `password: z.string().min(6)` (`src/pages/api/auth/signin.ts:10`); GoTrue `minimum_password_length = 6` (`supabase/config.toml:175`). New-password schema should align (`min(6)`), plus a `confirm` field with a refine for equality.
- **`form.handleSubmit` must `await`** the async submit (S-02 impl-review) or `isSubmitting`/double-submit breaks.
- **Don't leak the synthetic-email scheme** (`<username>@betcup.local`) in UI/errors.

## Code References

- `src/lib/supabase.ts:8-26` — `createClient` SSR session client (cookie bridge); the client to call `updateUser` on.
- `src/lib/supabase.ts:34-58` — `loadProfile()` (identity DTO; unrelated to the mutation but shows the pattern).
- `src/lib/supabase-admin.ts:19-29` — service-role client; **do not use** for S-07.
- `src/middleware.ts:4-12` — `PUBLIC_ROUTES` default-deny gate (new route auto-protected).
- `src/middleware.ts:39-57` — `locals.user` / `locals.profile` population via `getUser()`.
- `src/actions/index.ts:89-99` — `sessionClient()` authed client + `UNAUTHORIZED` guard.
- `src/actions/index.ts:50-56` — `inputError()` for field-scoped errors.
- `src/pages/api/auth/signin.ts:1-45` — auth API-route + zod pattern (Pattern B reference; also where `signInWithPassword` and `min(6)` live).
- `src/pages/api/auth/signout.ts:6-12` — sign-out + global-scope behavior.
- `src/components/admin/ParticipantForm.tsx:27-46` — canonical RHF + zod + Action + `isInputError` form (Pattern A reference).
- `src/components/predictions/PredictionForm.tsx:2,39,52` — Action import + call + reload-on-success.
- `src/lib/username.ts` — `synthEmail()` (needed if verifying current password via `signInWithPassword`).
- `src/lib/password.ts:45` — `generatePassword()` (admin-created accounts only; not for change flow).
- `src/components/ui/` — installed shadcn primitives: `button`, `form`, `input`, `label`, `popover`, `calendar` (no `toast`/`sonner`/`card`/`alert`/`dialog`).
- `src/env.d.ts:1-6`, `src/types.ts:11-16` — `App.Locals` and `Profile` shapes.
- `supabase/config.toml:175,215` — `minimum_password_length = 6`, `secure_password_change = false`.

## Architecture Insights

- **Two-lane auth design:** unauthenticated cookie-bootstrap (sign-in/out) lives in `src/pages/api/auth/*` (native POST + redirect); everything done by an authenticated user lives in Astro Actions + RHF islands. Password change straddles them conceptually but belongs in the Actions lane because the session already exists.
- **Default-deny middleware** means feature routes are secure-by-default; the only auth edits ever needed are to the small `PUBLIC_ROUTES`/`ADMIN_ROUTES` allowlists — not relevant here.
- **No service layer dir** (`src/lib/services/` doesn't exist yet); auth helpers live in `supabase.ts`, `supabase-admin.ts`, and inline in `actions/index.ts`. A new `src/lib/schemas/password.ts` (shared zod) is the natural home for validation.
- **Supabase manages the hard parts** (cookie rotation, JWT validation); the app's job is a thin authed mutation + good UX/error discipline.

## Historical Context (from prior changes)

- `context/archive/2026-05-28-identity-boundary/plan.md` (F-01) — established default-deny middleware, `profiles`/`user_roles`/RLS, removed self-signup, retrofitted `signin.ts`/`signout.ts` with `prerender = false` + zod. Explicitly states: "Not adding a password-change UI — **S-07 owns FR-003**."
- `context/archive/2026-06-03-admin-creates-participants/plan.md` (S-01) — username login via `synthEmail()`, service-role `auth.admin.createUser`, `generatePassword()`, generic sign-in errors. Explicitly defers password change/reset to S-07. The synthetic-email mapping here is what current-password reverification would reuse.
- `context/archive/2026-06-04-prediction-with-blindness/research.md` (S-03) — codifies "domain mutations → Astro Actions; auth endpoints → `src/pages/api/auth/*`." The interpretive crux for S-07's lane choice.
- `context/archive/2026-06-05-participant-match-history/` (S-05) — session-client reads; confirms `locals.user`/`profile` availability on participant pages.
- `context/foundation/prd.md` — FR-003 ("Participant can change their own password after logging in", must-have); admin sets initial password out-of-band, participant rotates after first login.
- `context/foundation/roadmap.md` (S-07, ~lines 161-171) — outcome: settings page, enter current + new + confirm, old password stops working; "lowest-risk slice; Supabase has built-in `updateUser({ password })`."

## Open Questions

1. **Lane decision:** Astro Action (recommended) vs `src/pages/api/auth/change-password.ts`. Resolve in `/10x-plan`. (Recommendation: Action.)
2. **Current-password verification mechanism:** since `secure_password_change = false`, do we (a) re-`signInWithPassword({ email: locals.user.email, password: current })` before `updateUser`, (b) call `auth.reauthenticate()`, or (c) flip `secure_password_change = true` in `supabase/config.toml`? Note (c) touches Supabase config — and would also need the production project setting, not just local. The roadmap *requires* asking for the current password, so app-level verification (a) is the most self-contained.
3. **"Sign out other sessions" on change?** Roadmap doesn't require it. Decide whether to add `signOut({ scope: 'others' })` for security hygiene or keep it out of scope.
4. **Settings page home:** new `src/pages/settings/index.astro` (matches roadmap wording) vs embed on `dashboard.astro`. Recommendation: new `/settings` route + dashboard nav link.
5. **Success UX:** no toast library installed. Inline success message vs `window.location.reload()` (existing convention) vs redirect. Minor.
6. **Lost-password / admin reset** (participant who never changed the initial password and forgot it) — S-01 deferred recovery to S-07, but this research's scope is in-app change only. Confirm whether S-07 must also cover admin-initiated reset, or whether that's a follow-up.
