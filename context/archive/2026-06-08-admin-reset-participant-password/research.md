---
date: 2026-06-08T17:30:00+02:00
researcher: mimazu
git_commit: df93940ab5a1bcaec95556ea0f58ac3b3d7f2789
branch: feature/S-09_admin-reset-participant-password
repository: bet-cup
topic: "S-09 — Admin resets a participant's password (system-generated temp; sessions revoked)"
tags: [research, codebase, admin, service-role, auth, session-revocation, FR-024]
status: complete
last_updated: 2026-06-08
last_updated_by: mimazu
---

# Research: S-09 — Admin resets a participant's password

**Date**: 2026-06-08T17:30:00+02:00
**Researcher**: mimazu
**Git Commit**: df93940ab5a1bcaec95556ea0f58ac3b3d7f2789
**Branch**: feature/S-09_admin-reset-participant-password
**Repository**: bet-cup (`michaemem/bet-cup`)

## Research Question

Ground the three open unknowns the roadmap assigned to `/10x-plan` for S-09 (`admin-reset-participant-password`, FR-024):

1. Which Supabase admin surface performs the reset, and how to keep it confined to the existing auth-only service-role client without widening the FR-015 blast radius.
2. The generated-password shape and how it is surfaced to the admin exactly once.
3. The session-revocation mechanism (global sign-out of the target user) and confirming it leaves the admin's own session intact.

## Summary

S-09 is a **small, additive slice** that extends a fully-established pattern. Unknowns #1 and #2 are essentially **already solved** by S-01's infrastructure — the reset action is a near-clone of `participants.create`, reusing the same service-role client, the same `generatePassword()`, and the same reveal-once UI. The only genuinely open design decision is **#3 (session revocation)**:

- **Password set:** `auth.admin.updateUserById(id, { password })` is the right call — already confirmed in the installed `@supabase/auth-js` and via Context7. It runs on the existing `createAdminAuthClient()` and fits the "auth-only write" contract exactly.
- **Password shape / reveal-once:** reuse `generatePassword()` (`src/lib/password.ts`) verbatim and mirror `ParticipantForm`'s green reveal panel + copy-to-clipboard + deferred reload. No new code needed beyond wiring.
- **Session revocation is the load-bearing unknown.** The installed supabase-js (`^2.99.1`) `GoTrueAdminApi` exposes **no "sign out all sessions by user id" method** — `signOut(jwt, scope)` requires the *target's* JWT, which the admin does not hold. `updateUserById({ password })` is **not documented to revoke existing sessions**. So FR-024's "the reset signs the participant out of their other sessions" needs a deliberate mechanism choice, verified empirically against the local stack. Candidate mechanisms and trade-offs are in [Open Questions](#open-questions).

The FR-015 isolation invariant (service-role client is auth-only, one reader, one importer) is enforced by a static test guard; S-09 adds a **third** sanctioned `auth.admin` write and must update the module banner + keep the guard green.

## Detailed Findings

### 1. The service-role admin surface (unknown #1 — essentially solved)

**`src/lib/supabase-admin.ts`** is the single sanctioned home for the service-role key:

```27:33:src/lib/supabase-admin.ts
  return createClient<Database>(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
```

- Reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `astro:env/server` (`src/lib/supabase-admin.ts:2`); returns `null` if either is missing.
- Built from `@supabase/supabase-js` (not `@supabase/ssr`) — stateless, no cookies, cannot pick up the request session.
- A prominent module banner documents the **SERVICE-ROLE ISOLATION** invariant (the load-bearing FR-015 guard): this is the ONLY module that reads the key; service-role bypasses RLS so it must NEVER read per-user data (predictions, profiles, roles); its only sanctioned uses are `auth.admin` *write* ops — today `createUser` (`participants.create`) and `deleteUser` (`participants.delete`).

**`src/actions/index.ts`** is the single production importer (`:14`). The `participants` namespace already has the exact shape S-09 mirrors:

- `participants.create` (`src/actions/index.ts:175-208`): `requireAdmin(context.locals)` → `createAdminAuthClient()` → `admin.auth.admin.createUser({ email: synthEmail(...), password: generatePassword(), email_confirm: true, user_metadata })` → returns `{ username, password }` once.
- `participants.delete` (`src/actions/index.ts:230-264`): `adminClient(context)` (RLS SSR) for the **target role read** (`user_roles` select; `admin` target → `FORBIDDEN`), then `createAdminAuthClient()` for the **write** (`auth.admin.deleteUser(id)`).

Shared helpers (`src/actions/index.ts`):
- `requireAdmin(locals)` (`:61-65`) — throws `UNAUTHORIZED` when `!locals.profile?.roles.includes("admin")`.
- `adminClient(context)` (`:74-81`) — RLS-respecting SSR client (anon key + caller cookies); calls `requireAdmin` internally. Use this for the **target role check** (mirror delete), NOT for the password write.
- `internalError(error)` (`:38-41`) — logs server-side, returns the stable generic `"Something went wrong. Please try again."`

**S-09 action shape (recommended):** `participants.resetPassword` next to create/delete. Input `{ id: z.uuid() }` (a `participantResetPasswordSchema` mirroring `participantDeleteSchema`, `src/lib/schemas/participant.ts:27-29`). Guard the target like delete does (refuse if the target holds `admin` — an admin resetting their own/another admin's password is out of scope and the single-admin invariant means the only admin is the caller). Generate the password server-side, call `updateUserById`, revoke sessions, return `{ password }` (and maybe `username`/`displayName` for the reveal panel) exactly once.

### 2. Password generation + reveal-once UI (unknown #2 — solved, reuse verbatim)

**`src/lib/password.ts`** — `generatePassword(length = 16)` (`:45`): Web Crypto (`crypto.getRandomValues`) over an unambiguous alphabet (no `0/O/1/l/I`), guarantees ≥1 lower, ≥1 upper, ≥1 digit, Fisher–Yates shuffle, rejection sampling (no modulo bias), never `Math.random`, never logs. The S-01 create flow already uses it and returns it once in the action response (`src/actions/index.ts:186-206`). **Reuse as-is.**

**Reveal-once panel** — `src/components/admin/ParticipantForm.tsx` is the exact UX template:
- State model `credentials: { username, password } | null` (`:11-25`); success swaps the form for a green reveal panel (`:64-90`) showing username + password in monospace, a Copy button via `navigator.clipboard.writeText(...)` (`:48-55`, with a 2s "Copied" flip using `lucide-react` `Check`/`Copy`), and a "Create another" button.
- **It intentionally does NOT auto-reload on success** (`:16-21`) — the response holds the only copy of the password; the list refresh is deferred to "Create another" → `form.reset()` + `window.location.reload()` (`:57-62`). S-09's reset panel must follow this exception, not the default reload-on-success used by every other admin form.

**Confirm-before-act** — `src/components/admin/DeleteParticipantButton.tsx` is the per-row destructive-action template: a shadcn `AlertDialog` (`src/components/ui/alert-dialog.tsx`) naming the participant, with a **plain confirm `Button` (not `AlertDialogAction`)** so the dialog stays open on error (`:54-74`). S-09's reset is destructive-ish (invalidates the old password + sessions), so a confirm dialog is appropriate — but the dialog must transition to (or hand off to) a reveal panel on success rather than reloading, since the temp password must be shown. (Available shadcn primitives: `alert-dialog`, `button`, `form`, `input`, `label`, `popover`, `calendar`. No `dialog`, no `toast`/`sonner` — refresh is always `window.location.reload()`.)

**Username↔email mapping** — `src/lib/username.ts` `synthEmail(username)` → `<username>@betcup.local`. The reset works by `id` (already known from the participant row), so `synthEmail` is only needed if a test signs the participant back in; `updateUserById` takes the `auth.users` id directly.

### 3. Session revocation (unknown #3 — the real open question)

**What the installed client offers.** `@supabase/supabase-js@^2.99.1` (`package.json:35`) → `auth-js` `GoTrueAdminApi` exposes: `createUser`, `listUsers`, `getUserById`, `updateUserById`, `deleteUser`, `inviteUserByEmail`, `generateLink`, and `signOut(jwt, scope)`. The full list (from `node_modules/@supabase/auth-js/dist/module/GoTrueAdminApi.js`):

```65:83:node_modules/@supabase/auth-js/dist/module/GoTrueAdminApi.js
    async signOut(jwt, scope = SIGN_OUT_SCOPES[0]) {
        if (SIGN_OUT_SCOPES.indexOf(scope) < 0) {
            throw new Error(`@supabase/auth-js: Parameter scope must be one of ${SIGN_OUT_SCOPES.join(', ')}`);
        }
        try {
            await _request(this.fetch, 'POST', `${this.url}/logout?scope=${scope}`, {
                headers: this.headers,
                jwt,
                noResolveJson: true,
            });
```

- `admin.signOut` **requires a valid JWT for the target user** — the admin performing a reset does not have the participant's JWT, so this is not directly usable.
- `admin.updateUserById(id, { password })` (`:687`) sets the password but is **not documented to revoke existing sessions** (Context7 + the GoTrue source give no such guarantee).
- There is **no `signOutUser(userId)` / "delete all sessions for user" method** in this client version.

**Existing precedent (self-service, different shape).** `account.changePassword` (`src/actions/index.ts:298-311`) revokes *other* sessions via the **session client** (the actor holds their own session): `updateUser({ password })` then `signOut({ scope: "others" })`. That mechanism does not transfer to an admin reset, because the admin is not the target and holds no target session. The account test asserts revocation by capturing a refresh token and asserting `refreshSession({ refresh_token })` later errors (`src/actions/account.test.ts:225-252`) — this assertion idiom **does** transfer to S-09.

**GoTrue session model (from Context7).** "When a user signs out, the sessions affected by the logout are removed from the database entirely." Sessions live in `auth.sessions`; refresh tokens in `auth.refresh_tokens`. A revoked/absent session makes `refreshSession` fail; the short-lived access token (default 1h) remains valid until expiry unless the app validates `session_id` against `auth.sessions` (BetCup does not — middleware calls `getUser()`).

→ Candidate mechanisms and trade-offs are enumerated in [Open Questions §A](#open-questions). This is the one decision `/10x-plan` must make and verify against the local stack.

### 4. Test harness (what S-09's tests will mirror)

- **Location:** extend `src/actions/participants.test.ts` (create + delete already live there) or a sibling file. Test runner is **Vitest 4**, env `happy-dom`, config `vitest.config.ts` (aliases `astro:actions`/`astro:env/server`/`astro:middleware` to stubs in `test/stubs/`). No central helper module — each live-DB suite inlines its fixtures.
- **Two-lane pattern:** an always-run **admin-guard** `describe` (mockable, runs in CI — throws before any DB call, context `{ locals: { profile: { roles } } }` only) plus a `describe.skipIf(!dbConfigured)` **live-DB** lane (`dbConfigured = Boolean(SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY)`). CI runs `npm test` (guards only; `participants.test.ts` live lane skips) and `npm test -- rls` against real Postgres (`.github/workflows/ci.yml:22,116`).
- **Reaching the handler:** `defineAction` is identity in the stub, so `(server.participants.resetPassword as ...).handler` is called directly (`participants.test.ts:47-82`).
- **Admin session for RLS reads** (if the reset does a delete-style role check): `adminContext()` signs in `admin@betcup.local` via a cookie-jar SSR client and builds a `request.headers.get("cookie")` stub (happy-dom forbids the `Cookie` header) — `participants.test.ts:238-263`.
- **Cleanup:** track created usernames; `afterAll` → `service.auth.admin.deleteUser(id)`.
- **Session-revocation assertion idiom** (reuse from account): mint a participant session via `anonClient().auth.signInWithPassword`, capture `refresh_token`, run the reset, assert `refreshSession({ refresh_token })` errors; assert old temp/password no longer signs in and the new one does (`account.test.ts:197-252`).
- **Scripts** (`package.json:5-21`): `db:start`, `db:reset`, `db:types`, `db:migration:new`, `test`, `lint`, `check:wrangler`.

### 5. Service-role isolation guard (must stay green)

The `testing-blindness-ownership` change added a **static, no-DB** test guard (lives in `src/db/predictions.rls.test.ts`, runs in the default `ci` job) asserting:
- exactly one production reader of `SUPABASE_SERVICE_ROLE_KEY` (`src/lib/supabase-admin.ts`),
- exactly one production importer of `@/lib/supabase-admin` / `createAdminAuthClient` (`src/actions/index.ts`),
- the admin module performs no `.from("predictions")` (ideally no data-table `.from(` at all).
- All scans exclude `*.test.*` and `test/` (per `lessons.md:12-17` — assert against production reads/importer count, never a raw `rg` across `src/`).

**S-09 impact:** the reset adds a **third** `auth.admin` write call site on the existing client — it does **not** add a new importer or reader, so the guard stays green *as long as* the reset stays auth-only (no `.from()` reads on the admin client; do the target role check on the RLS `adminClient`). The `supabase-admin.ts` banner comment (which enumerates sanctioned uses as `createUser`/`deleteUser`) should be updated to add `updateUserById` (password reset), mirroring how it was updated when delete landed.

## Code References

- `src/lib/supabase-admin.ts:2,5-21,27-33` — service-role client + isolation banner.
- `src/actions/index.ts:14` — sole importer of the admin client.
- `src/actions/index.ts:38-41,61-65,74-81` — `internalError`, `requireAdmin`, `adminClient` helpers.
- `src/actions/index.ts:175-208` — `participants.create` (the create template).
- `src/actions/index.ts:230-264` — `participants.delete` (RLS role-read + service-role write template; `admin` target → FORBIDDEN).
- `src/actions/index.ts:298-311` — `account.changePassword` (`updateUser` + `signOut({ scope: "others" })` self-service precedent).
- `src/lib/password.ts:45` — `generatePassword()` (reuse verbatim).
- `src/lib/username.ts:8` — `synthEmail()`.
- `src/lib/schemas/participant.ts:9-31` — `participantCreateSchema` + `participantDeleteSchema` (model for a reset schema).
- `src/components/admin/ParticipantForm.tsx:11-90` — reveal-once panel + copy + deferred reload.
- `src/components/admin/DeleteParticipantButton.tsx:31-74` — per-row AlertDialog confirm pattern.
- `src/pages/admin/participants.astro:10-38,67,88,101` — manage-participants SSR list (`id, display_name, username`, self excluded) + mounted islands.
- `src/actions/participants.test.ts:36-82,116-163,238-272` — two-lane test harness, handler reach, admin context, target setup.
- `src/actions/account.test.ts:225-252` — session-revocation assertion idiom (`refreshSession` on a captured token errors).
- `node_modules/@supabase/auth-js/dist/module/GoTrueAdminApi.js:65-83,687,735` — `signOut(jwt,scope)` (needs JWT), `updateUserById`, `deleteUser`.
- `astro.config.mjs:23-24` — `SUPABASE_SERVICE_ROLE_KEY` declared optional server secret.

## Architecture Insights

- **Auth lifecycle = service-role writes; everything else = RLS.** The codebase rigorously splits privileged auth-user mutations (`createUser`/`deleteUser`, and now `updateUserById`) onto the isolated admin client, while all *reads* (including the delete-target role check) go through the RLS-respecting SSR client. S-09 must preserve this split.
- **Reveal-once is a deliberate deviation** from the otherwise-universal "reload on success" refresh pattern. S-09's reset is the second instance of it.
- **No by-user-id session revocation in the SDK.** This is the architectural gap S-09 surfaces; the chosen mechanism becomes a small new capability (and a `lessons.md` candidate).
- **Defense in depth on the guard:** middleware gates `/admin/*` to admins; the action re-checks `requireAdmin`; RLS backstops reads; the static isolation test pins the service-role blast radius.

## Historical Context (from prior changes)

- `context/archive/2026-06-03-admin-creates-participants/plan.md` — established the service-role client, `generatePassword`, the reveal-once panel, the `synthEmail` mapping, and the two-lane test harness. S-09 is the closest sibling of this change. The "Service-role isolation is the load-bearing constraint" note (`:62`) applies directly.
- `context/archive/2026-06-05-testing-blindness-ownership/plan.md:106-134` — added the static isolation guard (one reader / one importer / no predictions read), encoding `lessons.md:12-17`. S-09 must keep this green.
- `context/foundation/lessons.md:12-17` — secret-isolation criteria must target production reads (exclude `*.test.*`), not a raw grep across `src/`.
- PRD `context/foundation/prd.md:87-88` (FR-024) — the decision record: system-generated temp (not admin-typed), revoke other sessions, no forced change-on-next-login (participant self-rotates via FR-003), email-reset rejected (Notifications Non-Goal), auth-only service-role surface.
- Roadmap `context/foundation/roadmap.md:190-203` (S-09) — outcome, the three unknowns, and the FR-015 risk framing.

## Related Research

- `context/archive/2026-06-05-testing-blindness-ownership/research.md` — service-role blast-radius analysis (the FR-015 boundary S-09 must not widen).

## Open Questions

### A. Session-revocation mechanism (the one real decision for `/10x-plan`)

FR-024 requires the reset to "sign the participant out of their other sessions." The SDK has no by-user-id sign-out, and `updateUserById({ password })` is not documented to revoke sessions. Candidate mechanisms (verify the chosen one against the local stack — assert a captured refresh token fails `refreshSession` after the reset, per `account.test.ts:225-252`):

1. **Rely on `updateUserById({ password })` alone, IF it revokes sessions.** Cleanest if true. **Must be empirically verified** — historically GoTrue does *not* revoke sessions on an admin password update, so this likely fails the assertion. Cheapest to try first to settle the question.
2. **Service-role SQL delete of the target's session rows.** After `updateUserById`, the admin client (service-role, RLS-bypassing) deletes the user's rows from `auth.sessions` (and/or `auth.refresh_tokens`) — GoTrue removes session rows on logout, so deleting them invalidates refresh. **Trade-off:** reaches into the GoTrue-owned `auth` schema (fragile across GoTrue versions) and means the admin client issues a `.from(...)`/RPC against an auth table — scrutinize against the isolation guard (the guard forbids `.from("predictions")` and ideally any data-table `.from(`; an `auth.sessions` delete is auth-lifecycle, not per-user app data, but the guard wording must be checked so it doesn't trip or get loosened).
3. **GoTrue admin REST `logout`/sessions endpoint via raw fetch.** If a by-user-id logout endpoint exists server-side, call it directly (the SDK doesn't wrap it). **Trade-off:** undocumented surface, version-coupling; least preferred.
4. **Accept access-token-until-expiry.** Whatever mechanism revokes refresh tokens, the existing short-lived access token (≤1h) stays valid until it expires (BetCup middleware doesn't validate `session_id`). Decide whether FR-024's "signed out of other sessions" is satisfied by refresh-token revocation (the same guarantee `account.changePassword` provides) — almost certainly yes, since that is the precedent already shipped and tested.

**Recommendation to carry into planning:** try (1) first to learn GoTrue's actual behavior on the local stack; if it doesn't revoke, prefer (2) scoped narrowly to `auth.sessions` for the target id, and treat refresh-token revocation (not access-token) as the bar FR-024 requires — matching the already-shipped `account.changePassword` guarantee. Update the isolation-guard wording deliberately if (2) is chosen.

### B. Admin-target guard

Should the reset refuse an `admin`-role target (like delete does at `src/actions/index.ts:241-246`)? The single-admin invariant means the only admin is the caller; refusing keeps the surface symmetric with delete and prevents an admin from resetting their own password through the wrong door (they use `/settings`/FR-003). Lean yes.

### C. Reveal-panel placement

Per-row reset → confirm dialog → reveal panel. Should the reveal live inside the `AlertDialog` (shown after confirm, dialog stays open) or replace the row/section like `ParticipantForm`? The per-row context argues for showing the temp password inside the dialog (with copy), then reloading only on dismiss. `/10x-plan` to decide the exact component composition.
