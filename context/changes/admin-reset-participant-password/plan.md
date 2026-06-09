# Admin Resets a Participant's Password (S-09) Implementation Plan

## Overview

Give the single admin a one-click way to reset any participant's password from the existing `/admin/participants` view (FR-024). A per-row "Reset password" control confirms behind an `AlertDialog`, then a tightly-scoped server Action uses the Supabase **service-role** client to (1) set a freshly **generated** temporary password on the target via `auth.admin.updateUserById({ password })` and (2) revoke the target's existing sessions via a `SECURITY DEFINER` SQL function that clears their `auth.sessions` rows. The temp password is revealed **once** inside the same dialog (with a Copy control) so the admin can share it out-of-band — the same handoff model as the S-01 initial password. The participant then signs in with the temp password and self-rotates it on `/settings` (FR-003); there is no forced change-on-next-login.

## Current State Analysis

Post-S-01/S-06 the repo already has every pattern this slice rides on (full detail in `context/changes/admin-reset-participant-password/research.md`):

- **Service-role surface (S-01):** `src/lib/supabase-admin.ts` is the single sanctioned reader of `SUPABASE_SERVICE_ROLE_KEY` and exposes `createAdminAuthClient()` (a stateless, no-cookie `@supabase/supabase-js` client). `src/actions/index.ts` is its only importer (`:14`). The module banner enumerates sanctioned uses as `createUser` (`participants.create`) and `deleteUser` (`participants.delete`).
- **Sibling actions (`src/actions/index.ts`):** `participants.create` (`:175-208`) — `requireAdmin` → `createAdminAuthClient()` → generated password → returns `{ username, password }` once. `participants.delete` (`:230-264`) — `adminClient(context)` (RLS SSR) reads the target's `user_roles`, refuses an `admin` target with `FORBIDDEN`, then uses the service-role client for the privileged write. Helpers: `requireAdmin` (`:61-65`), `adminClient` (`:74-81`), `internalError` (`:38-41`).
- **Password generator:** `generatePassword(length = 16)` (`src/lib/password.ts:45`) — Web Crypto, unambiguous charset, class guarantees, never logged. Returned once in the action response.
- **Reveal-once + copy UX:** `src/components/admin/ParticipantForm.tsx:11-90` (reveal panel, monospace, `navigator.clipboard`, deferred reload). Per-row destructive-confirm UX: `src/components/admin/DeleteParticipantButton.tsx:31-74` (controlled `AlertDialog`, plain confirm `Button` so the dialog stays open on error, `window.location.reload()` on success). shadcn primitives available: `alert-dialog`, `button`, `form`, `input`, `label`, `popover`, `calendar` (no `dialog`, no `toast`).
- **Manage-participants page:** `src/pages/admin/participants.astro:10-38` server-renders `id, display_name, username` (admin's own row excluded via `.neq("id", currentUser.id)`), mounting `DeleteParticipantButton` per row (`:67,88`) and `ParticipantForm` (`:101`).
- **Session-revocation precedent:** only self-service exists — `account.changePassword` (`:298-311`) does `updateUser({ password })` then `signOut({ scope: "others" })` on the **actor's** session client. The account test asserts revocation by checking a captured refresh token later fails `refreshSession` (`src/actions/account.test.ts:225-252`).
- **Isolation guard:** `src/db/predictions.rls.test.ts:389-431` (static, no-DB) asserts exactly one reader of the key, exactly one importer of the admin client, and **no `.from(`** inside `supabase-admin.ts`.
- **Test harness:** Vitest 4 + `happy-dom`; `astro:*` virtual modules stubbed in `test/stubs/`; two-lane pattern (always-run guard + `describe.skipIf(!dbConfigured)` live DB) in `src/actions/participants.test.ts`. CI runs `npm test` (guards only) and `npm test -- rls` (live DB).

### Key Discoveries:

- **The SDK has no by-user-id sign-out.** `@supabase/auth-js` (supabase-js `^2.99.1`) `GoTrueAdminApi.signOut(jwt, scope)` needs the *target's* JWT (`node_modules/@supabase/auth-js/dist/module/GoTrueAdminApi.js:65-83`); the admin doesn't hold it. `updateUserById({ password })` (`:687`) is **not** documented to revoke sessions. → revocation must be an explicit, deterministic step.
- **PostgREST does not expose the `auth` schema**, so the revoke must run as a `public`-schema `SECURITY DEFINER` function callable via `admin.rpc(...)`, not a `.from("auth.sessions")` call.
- **The isolation guard is unaffected by this change.** The new `admin.rpc("revoke_user_sessions", …)` call site lives in `src/actions/index.ts` (already the sole importer); `supabase-admin.ts` gains no `.from(` and no new key reader. All three guard assertions pass unchanged.
- **GoTrue removes session rows on logout** ("the sessions affected by the logout are removed from the database entirely"). Deleting the target's `auth.sessions` rows invalidates their refresh tokens (refresh requires the session), matching the FR-024 bar — the same guarantee `account.changePassword` already ships (refresh-token revocation; the short-lived access token lives until expiry, which BetCup's middleware does not separately validate).

## Desired End State

- The admin opens `/admin/participants`, clicks "Reset password" on a participant row, and confirms in a dialog that names the participant and warns the old password and sessions will be invalidated.
- On confirm, the dialog swaps to a reveal panel showing a freshly generated temp password with a Copy control; the list does not reload until the admin dismisses the panel.
- The target participant can no longer sign in with their old password; any active session they had can no longer be refreshed; they sign in with the temp password and can change it on `/settings`.
- Resetting a participant who holds the `admin` role is refused (`FORBIDDEN`); a non-admin who reaches the Action is refused (`UNAUTHORIZED`).
- `npm run lint`, `npm run build`, `npm run check:wrangler`, and `npm test` all pass; the live-DB integration test proves old-fails / temp-works / refresh-revoked; the static isolation guard stays green.

### Verification

- `npm test` (no DB): admin-guard + admin-target-refusal + schema unit tests pass; isolation guard green.
- `npm test -- participants` (local stack, all `SUPABASE_*` set): reset → old password rejected, temp password accepted, captured refresh token fails `refreshSession`.
- Manual: reset a local participant, confirm the reveal panel + Copy, sign in with the temp password, then change it on `/settings`.

## What We're NOT Doing

- **No forced change-on-next-login** — FR-024 decision: the participant self-rotates via FR-003 (`/settings`); the temp password is a normal working password until they change it.
- **No email/notification reset flow** — rejected per PRD Non-Goal (Notifications); the handoff is out-of-band, mirroring S-01.
- **No admin-typed password** — the system generates it (same as S-01 create); there is no password input field.
- **No reset for the admin's own account** — the admin rotates via `/settings`; admin-role targets are refused, and the page already excludes the admin's own row.
- **No bulk reset / reset history / audit trail** — single-target, no persistence beyond the auth password change (consistent with the MVP's no-soft-delete posture).
- **No change to the access-token lifetime or middleware session validation** — revocation targets refresh tokens (the shipped `account.changePassword` bar); access-token-until-expiry behavior is unchanged.
- **No second importer of the service-role client** — the reset action lives in the existing `src/actions/index.ts`.

## Implementation Approach

Bottom-up, mirroring S-01/S-06 so each phase is independently reviewable and committable: data layer (the revoke function) → server layer (schema + action + banner) → UI layer (per-row island) → integration tests + isolation guard. Defense-in-depth is preserved throughout: middleware gates `/admin/*`; the Action re-checks `requireAdmin`; the target role-read goes through the RLS SSR client (never the service-role client); the service-role client is used only for the two sanctioned auth-lifecycle operations (`updateUserById`, and the `revoke_user_sessions` RPC); the revoke function is locked to `service_role`.

## Critical Implementation Details

- **Operation ordering in the handler is load-bearing.** Set the password **first** (`updateUserById`), then revoke sessions. Mirrors `account.changePassword`'s "never revoke before the password is updated" rule (`src/actions/index.ts:287-297`). If the revoke step errors, throw `internalError` and do **not** reveal the password: a half-done reset (old password already dead, sessions still live, new password unseen) must fail loudly so the admin retries; the retry simply re-rotates to a new temp password (the operation is safely repeatable). Do not log-and-continue here (unlike `changePassword`, where the actor keeps their own session) — leaving a target's sessions alive silently would violate FR-024.
- **The revoke function must be `public`-schema, `SECURITY DEFINER`, and `service_role`-only.** PostgREST won't expose `auth`; the function deletes `auth.sessions` for the target id (which invalidates refresh tokens). Lock execution down: `revoke execute ... from public, anon, authenticated; grant execute ... to service_role;` so it is unreachable except via the server-only service-role client (and the Action guards `requireAdmin` before it ever runs). Schema-qualify `auth.sessions` and pin `search_path` so the definer body is unambiguous.
- **The temp password is revealed exactly once and must survive until dismissed.** Like `ParticipantForm`, the reset control must **not** auto-reload on success — the Action response holds the only copy. Reload only when the admin dismisses the reveal panel.

## Phase 1: Data layer — `revoke_user_sessions` function + types

### Overview

Add a `public`-schema `SECURITY DEFINER` function that clears a target user's `auth.sessions` rows, locked to `service_role`, and regenerate the typed DB client so the Action can call it via `admin.rpc(...)`.

### Changes Required:

#### 1. Migration

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_revoke_user_sessions.sql` (new — generate the name via `npm run db:migration:new revoke_user_sessions`)

**Intent**: Provide the one privileged primitive the SDK lacks — revoking all of a target user's sessions by user id — as a tightly-scoped, service-role-only RPC, so the reset Action can guarantee FR-024 revocation without touching the `auth` schema through PostgREST.

**Contract**: A function `public.revoke_user_sessions(target uuid) returns void`, `language sql`, `security definer`, with a pinned `search_path`, whose body deletes the target's session rows: `delete from auth.sessions where user_id = target;`. Grants: `revoke execute on function public.revoke_user_sessions(uuid) from public, anon, authenticated;` then `grant execute on function public.revoke_user_sessions(uuid) to service_role;`. Add a `comment on function` documenting that it is the FR-024 session-revocation primitive, callable only by the service-role client from `participants.resetPassword`, and must never be widened to other roles.

#### 2. Regenerated types

**File**: `src/db/database.types.ts` (regenerate)

**Intent**: Surface the new function under `Database["public"]["Functions"]` so `admin.rpc("revoke_user_sessions", { target })` is typed.

**Contract**: Run `npm run db:reset` (re-applies migrations) then `npm run db:types`; commit the diff (a `revoke_user_sessions` entry with a `target: string` arg and `void`/`undefined` return).

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npm run db:reset` completes without error.
- Types regenerate: `npm run db:types` exits 0 and `database.types.ts` gains `revoke_user_sessions`.
- Type-check/lint clean: `npx astro sync && npm run lint`.

#### Manual Verification:

- In Supabase Studio (or `psql`), confirm `public.revoke_user_sessions` exists as `SECURITY DEFINER` and that `anon`/`authenticated` lack EXECUTE while `service_role` has it.
- Sign a local participant in (capture a session), call the function as the service role for that user id, and confirm their `auth.sessions` row(s) are gone.

**Implementation Note**: After automated verification passes, pause for manual confirmation of the function's grants and revocation effect before starting Phase 2.

---

## Phase 2: Server layer — reset schema + `participants.resetPassword` Action

### Overview

Add the reset input schema, the admin-only `participants.resetPassword` Action (guard → target role-read → set password → revoke sessions → reveal once), and update the `supabase-admin.ts` banner to list the new sanctioned use. Unit-test the schema.

### Changes Required:

#### 1. Reset schema

**File**: `src/lib/schemas/participant.ts` (edit)

**Intent**: Shared validation for the reset control and Action — only the target id (the password is generated server-side, same as create).

**Contract**: Add `participantResetPasswordSchema = z.object({ id: z.uuid() })` and its `ParticipantResetPasswordInput` type, mirroring `participantDeleteSchema` (`:27-31`).

#### 2. `participants.resetPassword` Action

**File**: `src/actions/index.ts` (edit — add to the `participants` namespace)

**Intent**: Admin-only password reset. Reuse the delete handler's target-validation pattern and the create handler's generate-and-reveal pattern; perform the privileged set + revoke on the service-role client.

**Contract**: New `server.participants.resetPassword = defineAction({ accept: "json", input: participantResetPasswordSchema, handler })`, importing `participantResetPasswordSchema`. The handler:
1. `const supabase = adminClient(context);` (enforces `requireAdmin` and gives the RLS SSR client for the role read).
2. Read the target's roles: `supabase.from("user_roles").select("role").eq("user_id", input.id)` — exactly as `delete` (`:236-239`). Zero rows → `ActionError` `NOT_FOUND`/`BAD_REQUEST` ("Participant not found."); contains `admin` → `FORBIDDEN` ("Cannot reset an admin's password.").
3. `const admin = createAdminAuthClient();` → `INTERNAL_SERVER_ERROR` (`NOT_CONFIGURED`) if null.
4. `const password = generatePassword();`
5. `await admin.auth.admin.updateUserById(input.id, { password });` — on error, `throw internalError(error)`.
6. `await admin.rpc("revoke_user_sessions", { target: input.id });` — on error, `throw internalError(error)` (do **not** reveal the password; see Critical Implementation Details).
7. Return `{ password }`.

Never log the password.

#### 3. Service-role banner update

**File**: `src/lib/supabase-admin.ts` (edit — comment only)

**Intent**: Keep the isolation banner truthful as the sanctioned-uses list grows.

**Contract**: Extend the banner comment to add the password-reset use: `updateUserById` (set the temp password) and the `revoke_user_sessions` RPC (clear the target's sessions), both via `participants.resetPassword`. No code change.

#### 4. Schema unit test

**File**: `src/lib/schemas/participant.test.ts` (edit)

**Intent**: Pin the reset schema's contract.

**Contract**: Accept a valid uuid; reject a non-uuid / empty id.

### Success Criteria:

#### Automated Verification:

- Lint/type-check clean: `npx astro sync && npm run lint`.
- Build passes: `npm run build`.
- `check:wrangler` passes: `npm run check:wrangler`.
- Unit tests pass: `npm test` (participant-schema suite green, including the new reset cases).
- `SUPABASE_SERVICE_ROLE_KEY` still read in exactly one production module and `createAdminAuthClient` still has exactly one importer (the isolation guard, run via `npm test`, stays green).

#### Manual Verification:

- With the local service-role key set, the Action is reachable; without it, it returns the generic not-configured error (no crash).

**Implementation Note**: After automated verification, pause for manual confirmation that the action wiring + banner are correct before starting Phase 3.

---

## Phase 3: UI layer — per-row `ResetPasswordButton` island

### Overview

Add a per-row `ResetPasswordButton` that confirms behind an `AlertDialog`, then on success swaps the dialog body to a reveal panel (temp password + Copy) that stays open until dismissed, reloading on dismiss. Wire it into `participants.astro` beside the delete control.

### Changes Required:

#### 1. Reset control island

**File**: `src/components/admin/ResetPasswordButton.tsx` (new)

**Intent**: Per-row reset control combining `DeleteParticipantButton`'s confirm-dialog pattern with `ParticipantForm`'s reveal-once panel.

**Contract**: Props `{ id: string; displayName: string; username: string }`. A controlled `AlertDialog` (open state) triggered by a "Reset password" button. The footer confirm is a **plain `Button`** (not `AlertDialogAction`) so the dialog stays open on error. On confirm: call `actions.participants.resetPassword({ id })`; on error set an error string and keep the dialog open; on success store the returned `password` in state and render a reveal panel **inside the dialog** — display name + username + temp password in monospace, a Copy button (`navigator.clipboard.writeText` of a `Username: …\nPassword: …` block, mirroring `ParticipantForm.handleCopy` `:48-55`, with the `Check`/`Copy` icon flip), and a "Done" button that closes the dialog and `window.location.reload()`s. Do **not** reload until "Done". Confirm-stage copy must warn the reset invalidates the old password and signs the participant out of existing sessions.

#### 2. Wire into the participants page

**File**: `src/pages/admin/participants.astro` (edit)

**Intent**: Expose the reset control per row alongside delete, in both the mobile card list and the desktop table.

**Contract**: Pass `username` into the per-row controls (already selected at `:10-38`) and mount `<ResetPasswordButton id={…} displayName={…} username={…} client:load />` next to `DeleteParticipantButton` in both layouts (`:67`, `:88`). No server-query change beyond already selecting `id, display_name, username`.

### Success Criteria:

#### Automated Verification:

- Lint/type-check clean: `npx astro sync && npm run lint`.
- Build passes: `npm run build`.
- `check:wrangler` passes.

#### Manual Verification:

- As admin, each participant row shows a "Reset password" control beside "Delete".
- Clicking it opens a dialog that names the participant and warns about invalidation; confirming reveals a temp password with a working Copy; the list does NOT reload until "Done".
- A reset error keeps the dialog open with a message (does not close).
- Layout is correct on both the mobile card list and the desktop table; no horizontal overflow (FR-025).

**Implementation Note**: After automated verification, pause for manual confirmation of the UI behaviors before starting Phase 4.

---

## Phase 4: Integration tests + isolation guard

### Overview

Prove the end-to-end reset against a local Supabase (old password fails, temp works, sessions revoked) with the established two-lane harness, and confirm/strengthen the static isolation guard.

### Changes Required:

#### 1. Reset action tests

**File**: `src/actions/participants.test.ts` (edit — add reset cases)

**Intent**: Cover the admin-only guard, the admin-target refusal, and the FR-024 revocation that unit tests can't.

**Contract**: Reach the handler via `(server.participants.resetPassword as …).handler` (identity `defineAction`).
- **Always-run (CI, no DB):** a non-admin caller (`locals.profile.roles = ["participant"]`, plus the `request`/`cookies` context delete needs) → `UNAUTHORIZED`, asserted before any DB call.
- **Live DB (`describe.skipIf(!dbConfigured)`):**
  1. *Admin-target refusal:* attempt to reset the seeded admin's id → `FORBIDDEN` (mirrors delete's admin-target test).
  2. *Reset → old fails / temp works:* create a participant (reuse the `create` helper), sign them in to confirm the old password works, run the reset via an `adminContext()` (the cookie-jar SSR admin session, `:238-263`), then assert: old password `signInWithPassword` fails, and the returned temp password `signInWithPassword` succeeds.
  3. *Session revocation:* before the reset, sign the participant in on a second client and capture `refresh_token`; after the reset, assert `refreshSession({ refresh_token })` errors (idiom from `account.test.ts:225-252`).
- Track created users; `afterAll` cleans up via `service.auth.admin.deleteUser`.

#### 2. Isolation guard confirmation/strengthening

**File**: `src/db/predictions.rls.test.ts` (edit — `service-role isolation` describe, `:389-431`)

**Intent**: Keep the FR-015 blast-radius pinned now that the admin client performs a third operation; make the new RPC the *only* sanctioned data-touching call.

**Contract**: The three existing assertions must still pass unchanged (one reader, one importer, no `.from(` in `supabase-admin.ts`). Add one assertion that `supabase-admin.ts` issues no `.rpc(` either (it stays auth-only; the `revoke_user_sessions` RPC is called from `actions/index.ts`, not the module). Do not loosen any existing assertion.

### Success Criteria:

#### Automated Verification:

- `npm test` stays green in CI (guard + admin-target-refusal + schema run; live reset suite skips cleanly without the service-role key; isolation guard green).
- `npm test -- participants` passes locally with all `SUPABASE_*` env set (reset old-fails/temp-works/refresh-revoked + admin-target refusal green).
- Lint + build still pass.

#### Manual Verification:

- Full loop: reset participant `bob` → copy temp password → `bob`'s old password no longer signs in → temp password signs in → `bob` changes it on `/settings`.
- Re-running the live test a couple of times shows no flakiness in the refresh-revocation assertion.

**Implementation Note**: After Phase 4, pause for manual confirmation of the full reset loop before considering S-09 complete.

---

## Testing Strategy

### Unit Tests:

- `participantResetPasswordSchema`: accepts a valid uuid, rejects non-uuid/empty.

### Integration Tests (live Supabase):

- Admin-only guard refusal (also runs in CI, mockable).
- Admin-target refusal (`FORBIDDEN`).
- Reset → old password rejected, temp password accepted.
- Session revocation → captured refresh token fails `refreshSession`.

### Static Tests (no DB):

- Service-role isolation guard: one reader, one importer, no `.from(`/`.rpc(` on `supabase-admin.ts`.

### Manual Testing Steps:

1. `npm run db:reset`; set `SUPABASE_SERVICE_ROLE_KEY` in `.dev.vars`; `npm run dev`; sign in as `admin` → `/admin/participants`.
2. Create a participant `bob`; sign out; sign in as `bob` to confirm the initial password works; leave a session active in another browser/profile.
3. As admin, click "Reset password" on `bob` → confirm → copy the temp password.
4. Confirm `bob`'s old password no longer signs in; the temp password does; the other active session can no longer act (its refresh fails).
5. As `bob`, change the password on `/settings`; confirm the new one works.
6. Confirm resetting the admin's own row is not offered (excluded) and that a crafted reset of an admin id returns `FORBIDDEN`.

## Performance Considerations

Negligible at the 5–20-user scale: one indexed `user_roles` read, one `updateUserById` round-trip, one `auth.sessions` delete per reset.

## Migration Notes

- **Additive, forward-only.** The migration only adds a function + grants; reverting the Worker does not require reverting it, and it is harmless if left in place. Per AGENTS.md, Supabase migrations are not auto-applied to prod — after merge, apply with `npx supabase db push` (preview with `--dry-run`).
- **`auth`-schema coupling.** The function reads GoTrue's `auth.sessions`. If a future GoTrue upgrade changes that table, the function (and the revocation test) is where it surfaces — acceptable for the MVP and pinned by the live test.
- **No new secret.** Reuses the existing `SUPABASE_SERVICE_ROLE_KEY` (operator step from S-01: `npx wrangler secret put` in prod, local key in `.dev.vars`).

## References

- Change folder: `context/changes/admin-reset-participant-password/`
- Research: `context/changes/admin-reset-participant-password/research.md`
- Roadmap: `context/foundation/roadmap.md` S-09 (`:190-203`).
- PRD: FR-024 (`context/foundation/prd.md:87-88`); Access Control (`:142-151`).
- S-01 (create + service-role surface): `context/archive/2026-06-03-admin-creates-participants/plan.md`; `src/actions/index.ts:175-208`, `src/lib/supabase-admin.ts`, `src/lib/password.ts`.
- S-06 (delete: target role-read + per-row confirm): `src/actions/index.ts:230-264`, `src/components/admin/DeleteParticipantButton.tsx`.
- Self-service revocation precedent + test idiom: `src/actions/index.ts:298-311`, `src/actions/account.test.ts:225-252`.
- Isolation guard: `src/db/predictions.rls.test.ts:389-431`; `context/foundation/lessons.md:12-17`.
- SDK admin API: `node_modules/@supabase/auth-js/dist/module/GoTrueAdminApi.js:65-83,687`.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Data layer — `revoke_user_sessions` function + types

#### Automated

- [x] 1.1 Migration applies cleanly: `npm run db:reset` completes without error — fb6edb2
- [x] 1.2 Types regenerate: `npm run db:types` exits 0 and `database.types.ts` gains `revoke_user_sessions` — fb6edb2
- [x] 1.3 Type-check/lint clean: `npx astro sync && npm run lint` — fb6edb2

#### Manual

- [x] 1.4 `public.revoke_user_sessions` exists as SECURITY DEFINER; `anon`/`authenticated` lack EXECUTE, `service_role` has it — fb6edb2
- [x] 1.5 Calling it as service role for a signed-in user removes their `auth.sessions` row(s) — fb6edb2

### Phase 2: Server layer — reset schema + `participants.resetPassword` Action

#### Automated

- [x] 2.1 Lint/type-check clean: `npx astro sync && npm run lint` — d536bc7
- [x] 2.2 Build passes: `npm run build` — d536bc7
- [x] 2.3 `check:wrangler` passes: `npm run check:wrangler` — d536bc7
- [x] 2.4 Unit tests pass: `npm test` (participant-schema suite incl. new reset cases) — d536bc7
- [x] 2.5 Isolation guard green: one reader / one importer (`npm test`) — d536bc7

#### Manual

- [x] 2.6 Action reachable with the local service-role key; returns generic not-configured error without it (no crash) — d536bc7

### Phase 3: UI layer — per-row `ResetPasswordButton` island

#### Automated

- [x] 3.1 Lint/type-check clean: `npx astro sync && npm run lint`
- [x] 3.2 Build passes: `npm run build`
- [x] 3.3 `check:wrangler` passes

#### Manual

- [x] 3.4 Each row shows "Reset password" beside "Delete" (verified in SSR markup: per-row outline trigger before destructive Delete, both layouts)
- [x] 3.5 Confirm dialog warns about invalidation; confirming reveals a temp password with working Copy; list does NOT reload until "Done" (user-confirmed in browser)
- [x] 3.6 A reset error keeps the dialog open with a message (user-confirmed in browser)
- [x] 3.7 Correct layout on mobile card list + desktop table, no horizontal overflow (user-confirmed in browser)

### Phase 4: Integration tests + isolation guard

#### Automated

- [ ] 4.1 `npm test` stays green in CI (guard + admin-target-refusal + schema run; live reset suite skips cleanly; isolation guard green)
- [ ] 4.2 `npm test -- participants` passes locally with all `SUPABASE_*` set (old-fails/temp-works/refresh-revoked + admin-target refusal)
- [ ] 4.3 Lint + build still pass

#### Manual

- [ ] 4.4 Full loop: reset `bob` → old password fails → temp works → `bob` changes it on `/settings`
- [ ] 4.5 Live revocation test stable across a couple of reruns
