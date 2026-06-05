# Account Settings: Change Password & Display Name Implementation Plan

## Overview

Add a `/settings` page where any logged-in user (participant **or** admin) can (a) change their display name — the name shown on the leaderboard and in other participants' history views — and (b) change their password. Both mutations require the user to confirm their **current password**. Built entirely on the existing Astro Actions + react-hook-form + zod + shadcn lane. No database migration is required: the `profiles` table already permits self-update via RLS, and password change is a pure `auth.users` update through the Supabase session client. The PRD and roadmap are updated to reflect the expanded, role-agnostic scope.

## Current State Analysis

- **No settings/account page exists.** The only authenticated hub is `dashboard.astro`, which greets by `profile.displayName` and has a sign-out form (`src/pages/dashboard.astro:14,55-61`).
- **Password change is unimplemented.** `supabase.auth.updateUser()` is used nowhere. Sign-in/out live in `src/pages/api/auth/*` (native POST + redirect); every *in-session* mutation uses Astro Actions (`src/actions/index.ts`).
- **Display-name change is unimplemented but DB-ready.** `profiles_update` RLS already allows an authenticated user to update their own row (`auth.uid() = id` USING + WITH CHECK, `supabase/migrations/20260528232000_identity_boundary.sql:168-172`). `display_name` has no uniqueness constraint (only `username` does). The generated `Update` type allows `display_name?: string` (`src/db/database.types.ts:185-194`).
- **Display name is read-through everywhere.** Canonical store is `profiles.display_name`; the leaderboard view, `profiles_public`, dashboard greeting, cross-participant history title, and admin participant list all read from it, so a single update propagates on the next request (no extra write paths).
- **Auth verification is on us.** `secure_password_change = false` (`supabase/config.toml:215`) means Supabase does not require reauth for `updateUser({ password })`. We verify the current password ourselves via `signInWithPassword`.
- **Admin is just a user.** Admin authenticates the same way; `updateUser`/`profiles.update` and `sessionClient()` work identically. No role gating on these actions — they operate on `auth.uid()` / `locals.user`.
- **Conventions to mirror:** action helpers `sessionClient()`, `inputError()`, `internalError()` (`src/actions/index.ts:36-99`); shared zod schemas in `src/lib/schemas/`; RHF + `isInputError` form pattern (`src/components/admin/ParticipantForm.tsx:27-46`); display-name validation `trim().min(1).max(80)` no regex (`src/lib/schemas/participant.ts:9-22`); password `min(6)` matching sign-in and GoTrue (`src/pages/api/auth/signin.ts:10`, `supabase/config.toml:175`).

## Desired End State

A logged-in user navigates to `/settings` (link from the dashboard). They see two cards:

1. **Display name** — pre-filled with their current name. Editing it + entering their current password + confirming updates `profiles.display_name`; the new name appears on the dashboard, leaderboard, and history views.
2. **Password** — entering current password + new password + confirm changes their password; subsequent logins use the new password, the old password stops working, and **other devices are signed out** (current device stays logged in).

Both forms show inline field errors (wrong current password, validation failures) and a success message, then reload. The PRD (FR-003 generalized + new display-name FR + Access Control) and roadmap (S-07) describe this role-agnostic behavior.

### Key Discoveries:

- Self-update RLS already in place: `supabase/migrations/20260528232000_identity_boundary.sql:168-172` — **no migration needed**.
- `sessionClient()` returns `{ supabase, user }` and throws `UNAUTHORIZED` when unauthenticated (`src/actions/index.ts:89-99`) — the exact primitive both actions need.
- `user.email` carries the synthetic `<username>@betcup.local` (or the admin's real email), so `signInWithPassword({ email: user.email, password: current })` verifies the current password for both roles (`src/lib/username.ts`, `src/lib/supabase.ts:100` context).
- `profiles_update` WITH CHECK is **column-agnostic**, so the action must send only `{ display_name }` to avoid touching `username`/`legal_name` (`supabase/migrations/20260528232000_identity_boundary.sql:168-172`).
- No toast infra; existing forms reload on success (`src/components/predictions/PredictionForm.tsx:52`).

## What We're NOT Doing

- **No lost-password / email recovery flow** (`resetPasswordForEmail`). Out of scope; this is in-session change only.
- **No admin-initiated password reset for other users** (admin resetting a participant's forgotten password). Tracked separately if needed.
- **No username editing** (the login handle). Only the public `display_name` is editable here.
- **No display-name uniqueness enforcement** — duplicates remain allowed, consistent with creation.
- **No DB migration and no RLS change** — existing policies suffice.
- **No `secure_password_change` config flip** — verification is handled in app code.
- **No toast library** — inline messages + reload, matching existing convention.
- **No new shadcn primitives unless required** — reuse `button`, `form`, `input`, `label`.

## Implementation Approach

Two independent Astro Actions under a new `account` group, each self-contained:

- `account.changeDisplayName({ displayName, currentPassword })`: verify current password → `profiles.update({ display_name }).eq("id", user.id)`.
- `account.changePassword({ currentPassword, newPassword, confirmPassword })`: verify current password → `updateUser({ password: newPassword })` → `signOut({ scope: "others" })`.

Both reuse `sessionClient()`. Verification is a shared inline helper that calls `signInWithPassword` **on a transient, non-persistent client** (a throwaway `@supabase/supabase-js` client created with `auth.persistSession: false`) — deliberately **not** the session client — and maps failure to `inputError("currentPassword", "Current password is incorrect.")`. Verifying off-session means the caller's live session/cookies are never rotated, so `signOut({ scope: "others" })` targets only genuinely-other devices and the "keep the current device signed in" guarantee no longer depends on action `Set-Cookie` propagation. The UI is two RHF islands on one Astro page; success triggers an inline message + `window.location.reload()`.

## Critical Implementation Details

- **Action call ordering for password change** is load-bearing: (1) verify the current password via `signInWithPassword` **on a transient `persistSession: false` client** (so the caller's live session and cookies are untouched), (2) `updateUser({ password })` on the session client, (3) `signOut({ scope: "others" })` on the session client. `scope: "others"` preserves the current device while invalidating all other refresh tokens — and it also reaps the short-lived session the transient verify client created server-side. Doing `signOut` before `updateUser` would revoke sessions against the old password state. Never pass the default (global) scope here or the acting user is logged out mid-flow.
- **Column scoping on the profile update:** send only `{ display_name }`. The `profiles_update` policy does not restrict columns, so an over-broad payload could silently mutate `username`/`legal_name`.
- **Error discipline:** distinguish the two `signInWithPassword` failure classes. An **invalid-credentials** failure (wrong current password — GoTrue `invalid_credentials` / HTTP 400) surfaces as a field error on `currentPassword`. Any **other** failure (rate limit / 429, network, misconfig) is logged server-side and surfaced via `internalError()` — do **not** report it as "Current password is incorrect.", which would both mislead the user and mask the real fault. Never echo a raw GoTrue message and never leak the synthetic-email scheme.

## Phase 1: Schemas + backend Actions

### Overview

Add validation schemas and the two server actions with current-password verification. This phase is independently testable via unit + integration tests without any UI.

### Changes Required:

#### 1. Account validation schemas

**File**: `src/lib/schemas/account.ts`

**Intent**: Shared zod schemas for both forms, consumed by the RHF resolver and the action `input`. Mirror existing schema style and the established length rules.

**Contract**:
- `changeDisplayNameSchema` = `{ displayName: string (trim, min 1 "Name is required", max 80), currentPassword: string (min 1, "Current password is required") }`.
- `changePasswordSchema` = `{ currentPassword: string (min 1), newPassword: string (min 6, "New password must be at least 6 characters"), confirmPassword: string }` with two refines: `newPassword === confirmPassword` (path `confirmPassword`, "Passwords do not match") and `newPassword !== currentPassword` (path `newPassword`, "New password must be different from the current one").
- Export inferred types `ChangeDisplayNameInput`, `ChangePasswordInput`.

#### 2. `account` action group with current-password verification

**File**: `src/actions/index.ts`

**Intent**: Add an `account` group to the exported `server` object with `changeDisplayName` and `changePassword`, plus a small shared helper that verifies the current password by signing in on a **transient, non-persistent** client. Both actions use `sessionClient()` for the actual mutation (no admin role required); verification is deliberately kept off the session client so the caller's live session/cookies are never rotated.

**Contract**:
- New helper `verifyCurrentPassword(email, password)`: builds a throwaway `@supabase/supabase-js` client against `SUPABASE_URL` + the anon `SUPABASE_KEY` with `{ auth: { persistSession: false, autoRefreshToken: false } }`, calls `signInWithPassword({ email, password })`; on **invalid-credentials** error throws `inputError("currentPassword", "Current password is incorrect.")`, on any **other** error throws `internalError(error)` (see Error discipline). Does not touch the request cookies. The short-lived session it creates server-side is reaped by the later `signOut({ scope: "others" })` (password flow) or simply expires (display-name flow).
- `account.changeDisplayName`: `accept: "json"`, `input: changeDisplayNameSchema`. Handler: `const { supabase, user } = sessionClient(context)`; `await verifyCurrentPassword(user.email!, input.currentPassword)`; `await supabase.from("profiles").update({ display_name: input.displayName }).eq("id", user.id)`; map DB error via `internalError`. Return `{ ok: true }` (or the new name).
- `account.changePassword`: `accept: "json"`, `input: changePasswordSchema`. Handler: `sessionClient` → `verifyCurrentPassword` → `await supabase.auth.updateUser({ password: input.newPassword })` (map error via `internalError`) → `await supabase.auth.signOut({ scope: "others" })` (log-and-continue on error; the password change already succeeded). Return `{ ok: true }`.
- Guard `user.email` may be `null` in the type: throw `internalError` if absent (should never happen for a signed-in user).

#### 3. Schema unit tests

**File**: `src/lib/schemas/account.test.ts`

**Intent**: Pin the validation contract, especially the refines (mismatch + same-as-current), mirroring `src/lib/schemas/participant.test.ts`.

**Contract**: Vitest cases — valid inputs pass; empty display name / >80 fails; short new password fails; mismatched confirm fails on `confirmPassword`; `newPassword === currentPassword` fails on `newPassword`.

#### 4. Action integration tests

**File**: `src/actions/account.test.ts`

**Intent**: Exercise both actions against the local Supabase stack. This reuses *parts* of the `src/actions/participants.test.ts` setup (stubbed `astro:actions`/`astro:env/server`, create a user via the service-role admin client, self-skip via `dbConfigured`) but **needs a richer call context than that harness builds**: `participants.create` passes only `{ locals: { profile } }` and runs on the service-role client, whereas the account handlers call `sessionClient(context)` and then mutate (`updateUser`, `profiles.update`) on an **authenticated** SSR client under RLS. So the harness must:

- **Construct a full `context`**: `{ locals: { user }, request, cookies }` where `user = { id, email }` (the created user), `request = new Request("http://localhost/", { headers: { Cookie: <ssr-auth-cookie> } })`, and `cookies` is a minimal `AstroCookies` stub exposing `get`/`getAll`/`set` (`set` may collect into a map; `getAll` may be empty since the auth state rides on the `Cookie` header).
- **Authenticate the session client**: sign the user in with an anon `@supabase/supabase-js` client to get `{ access_token, refresh_token }`, then seed that session into the SSR client the handler builds — the tractable route is to write the `@supabase/ssr` chunked auth cookie (`sb-<ref>-auth-token`) into the `request` `Cookie` header so `createClient(...)` reads it via `getAll()`. (`createClient` reads cookies from `request.headers`, not from the `cookies` stub — see `src/lib/supabase.ts:14-18`.) If reconstructing that cookie proves brittle, fall back to asserting the mutation directly against the live DB with the user's own anon client and reserve the handler invocation for the verify/error cases.
- **Env**: relies on `SUPABASE_ANON_KEY` (the env stub maps it to `SUPABASE_KEY`) + `SUPABASE_SERVICE_ROLE_KEY` + `SUPABASE_DB_URL`, same as the participants harness.

**Contract**: Cases — wrong current password → input error on `currentPassword`, no change persisted; correct current password + valid new name → `profiles.display_name` updated for that user only; correct current password + valid new password → can sign in with new password, cannot with old; display-name update does not alter `username`/`legal_name`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Schema unit tests pass: `npx vitest run src/lib/schemas/account.test.ts`
- Action integration tests pass (local Supabase running): `npx vitest run src/actions/account.test.ts`
- Production build succeeds: `npm run build`

#### Manual Verification:

- Invoking `account.changePassword` with the wrong current password returns a field error and does not change the password.
- After a successful password change, the old password no longer authenticates and a second device's session is invalidated on its next request.
- After a successful display-name change, `profiles.display_name` reflects the new value and `username`/`legal_name` are untouched.

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Settings UI

### Overview

Build the `/settings` page with two RHF islands and link to it from the dashboard.

### Changes Required:

#### 1. Display name form island

**File**: `src/components/account/DisplayNameForm.tsx`

**Intent**: RHF + `zodResolver(changeDisplayNameSchema)` form with `displayName` (pre-filled from a prop) and `currentPassword` fields, calling `actions.account.changeDisplayName`. Mirror `ParticipantForm.tsx` error handling (`isInputError` → `form.setError`, else `setServerError`).

**Contract**: Props `{ currentDisplayName: string }`. shadcn `Form`/`Input`/`Button`; `type="password"` for the current-password field. On success: inline success message + `window.location.reload()`. `await form.handleSubmit(...)`.

#### 2. Password form island

**File**: `src/components/account/ChangePasswordForm.tsx`

**Intent**: RHF + `zodResolver(changePasswordSchema)` form with `currentPassword`, `newPassword`, `confirmPassword`, calling `actions.account.changePassword`. Same error/success handling.

**Contract**: No props. Three `type="password"` inputs. On success: inline success message ("Password changed; other devices were signed out.") + `window.location.reload()`.

#### 3. Settings page

**File**: `src/pages/settings/index.astro`

**Intent**: Authenticated page (auto-protected by default-deny middleware) rendering both forms in two sections. Pass `Astro.locals.profile.displayName` into `DisplayNameForm`.

**Contract**: Uses `Layout`; participant light layout consistent with `predictions/index.astro` (`mx-auto max-w-3xl p-6`). Two headed sections ("Display name", "Password"). Both islands `client:load`. Defensive: if `profile` is null, fall back to empty string.

#### 4. Dashboard navigation link

**File**: `src/pages/dashboard.astro`

**Intent**: Add a "Settings" link to the existing nav so users can reach `/settings`.

**Contract**: Anchor to `/settings` in the dashboard nav block (alongside existing links), matching existing link styling.

### Success Criteria:

#### Automated Verification:

- Lint/type check passes: `npm run lint`
- Production build succeeds: `npm run build`

#### Manual Verification:

- `/settings` loads for a logged-in participant and for the admin; unauthenticated access redirects to `/auth/signin`.
- Display-name form is pre-filled; changing it with the correct current password updates the dashboard greeting, leaderboard entry, and the user's history-page title after reload.
- Wrong current password shows an inline error on the current-password field in both forms.
- Password form: mismatched confirm and "same as current" show inline errors; a valid change logs out a second browser session and keeps the current one.
- Layout is consistent with other participant pages on desktop and mobile widths.

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 3: PRD + roadmap documentation

### Overview

Update foundation docs so the expanded, role-agnostic scope is recorded.

### Changes Required:

#### 1. PRD — generalize FR-003, add display-name FR, update Access Control

**File**: `context/foundation/prd.md`

**Intent**: Make password change role-agnostic and document display-name editing as a first-class requirement.

**Contract**:
- FR-003 reworded to: "User (participant or admin) can change their own password after logging in; changing it requires confirming the current password and signs out other sessions." Priority: must-have.
- New FR (next free id, **FR-023**) under Authentication & Accounts: "User (participant or admin) can change their own display name — the name shown on the leaderboard and in other participants' revealed history. Changing it requires confirming the current password; display names need not be unique." Priority: must-have.
- Access Control "Authentication" paragraph: note that both roles can change their own password and display name from a settings page.

#### 2. Roadmap — expand S-07

**File**: `context/foundation/roadmap.md`

**Intent**: Reflect that S-07 now covers admin + display-name editing.

**Contract**:
- "At a glance" S-07 row outcome → "user (participant or admin) changes their own password and display name from a settings page"; PRD refs → `FR-003, FR-023`.
- S-07 slice section: update Outcome (current + new password + display name, current-password confirmation, other sessions signed out), PRD refs, and clear `Unknowns` (resolved by this plan). Backlog Handoff row title/notes updated to match.

### Success Criteria:

#### Manual Verification:

- FR-003 reads role-agnostically; new FR-023 present and consistent with the implemented behavior.
- Roadmap S-07 outcome and PRD refs match the shipped feature; no dangling "Unknowns".
- No contradictions between PRD, roadmap, and the implemented actions (current-password required, other-session sign-out on password change).

---

## Testing Strategy

### Unit Tests:

- `src/lib/schemas/account.test.ts` — both schemas, all refines and bounds.

### Integration Tests:

- `src/actions/account.test.ts` — both actions end-to-end against local Supabase: wrong/right current password, name update isolation (no `username`/`legal_name` drift), password update (old fails / new works), other-session behavior.

### Manual Testing Steps:

1. Sign in as a participant, open `/settings`; confirm display name is pre-filled.
2. Change display name with correct current password → reload → verify new name on dashboard, `/leaderboard`, and `/history/<id>`.
3. Submit display-name change with wrong current password → inline field error, no change.
4. Change password with correct current password in browser A while logged in in browser B → browser B is signed out on next navigation; browser A stays in.
5. Try new password === current, and mismatched confirm → inline errors.
6. Sign out, sign in with the new password (old password rejected).
7. Repeat 1–6 as the admin to confirm role-agnostic behavior.
8. Visit `/settings` unauthenticated → redirected to `/auth/signin`.

## Performance Considerations

Negligible. Each action performs one auth round-trip (verification), one mutation, and (for password) one sign-out call — all on a 5–20 user pool. No new indexes or queries on hot paths.

## Migration Notes

None. No schema or RLS changes; existing `profiles_update` policy and `auth.users` update path are used as-is.

## References

- Research: `context/changes/participant-changes-password/research.md`
- Self-update RLS: `supabase/migrations/20260528232000_identity_boundary.sql:163-177`
- Action helpers to mirror: `src/actions/index.ts:36-99`
- Form pattern: `src/components/admin/ParticipantForm.tsx:27-46`
- Display-name validation precedent: `src/lib/schemas/participant.ts:9-22`
- Display-name read surfaces: `src/pages/leaderboard/index.astro:25-37`, `src/pages/history/[participantId].astro:33-47`, `src/pages/dashboard.astro:14`
- Password constraints: `src/pages/api/auth/signin.ts:10`, `supabase/config.toml:175,215`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Schemas + backend Actions

#### Automated

- [x] 1.1 Type checking passes: `npm run lint` — a25e1e1
- [x] 1.2 Schema unit tests pass: `npx vitest run src/lib/schemas/account.test.ts` — a25e1e1
- [x] 1.3 Action integration tests pass: `npx vitest run src/actions/account.test.ts` — a25e1e1
- [x] 1.4 Production build succeeds: `npm run build` — a25e1e1

#### Manual

- [x] 1.5 Wrong current password returns a field error and does not change the password — a25e1e1
- [x] 1.6 After password change, old password fails and another device's session is invalidated — a25e1e1
- [x] 1.7 Display-name update changes only `display_name` (not `username`/`legal_name`) — a25e1e1

### Phase 2: Settings UI

#### Automated

- [x] 2.1 Lint/type check passes: `npm run lint` — dfde5fa
- [x] 2.2 Production build succeeds: `npm run build` — dfde5fa

#### Manual

- [x] 2.3 `/settings` loads for participant and admin; unauth redirects to `/auth/signin` — dfde5fa
- [x] 2.4 Display-name change propagates to dashboard, leaderboard, history title after reload — dfde5fa
- [x] 2.5 Wrong current password shows inline error in both forms — dfde5fa
- [x] 2.6 Password form: mismatch and same-as-current show inline errors; valid change signs out other session, keeps current — dfde5fa
- [ ] 2.7 Layout consistent with other participant pages on desktop + mobile

### Phase 3: PRD + roadmap documentation

#### Manual

- [x] 3.1 FR-003 reads role-agnostically; new FR-023 present and consistent
- [x] 3.2 Roadmap S-07 outcome and PRD refs match shipped feature; no dangling Unknowns
- [x] 3.3 No contradictions between PRD, roadmap, and implemented actions
