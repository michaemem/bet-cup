# Delete Participant (S-06) Implementation Plan

## Overview

Let the admin hard-delete a participant from the `/admin/participants` view. Per the roadmap's resolved decision (Open Roadmap Questions §2, FR-004), this is a **cascade hard-delete** — no soft-delete, no audit trail. The deleted participant's predictions and earned points disappear from every other participant's revealed history and from the leaderboard, and the participant can no longer log in.

The deletion root is a single service-role `auth.admin.deleteUser(id)` call. Every downstream removal happens automatically through existing `ON DELETE CASCADE` foreign keys, and the leaderboard/history views are live (`security_invoker`), so they recompute on the next read. There is **no migration** in this change.

## Current State Analysis

- **The cascade is already wired end-to-end** (no schema work needed):
  - `public.profiles.id → auth.users(id) ON DELETE CASCADE` (`supabase/migrations/20260528232000_identity_boundary.sql:18`)
  - `public.user_roles.user_id → auth.users(id) ON DELETE CASCADE` (`...identity_boundary.sql:50`)
  - `public.predictions.predictor_id → public.profiles(id) ON DELETE CASCADE` (`supabase/migrations/20260604184657_predictions_with_blindness.sql:29`)
  - So deleting one `auth.users` row removes: that row → its profile + role rows → its predictions. `match_results` is keyed by `match_id` (not participant) and is untouched.
- **Views recompute for free.** `prediction_scores` and `leaderboard` are `security_invoker` views over `predictions`/`profiles_public` (`supabase/migrations/20260605052647_results_scoring_leaderboard.sql:99,121`). Once a participant's predictions are gone and their profile row is gone, they vanish from both — no invalidation, no materialized state.
- **The service-role client is the only path that can delete the `auth.users` row.** `createAdminAuthClient()` (`src/lib/supabase-admin.ts:19`) wraps `SUPABASE_SERVICE_ROLE_KEY`. Its banner currently declares "exactly ONE importer: the `participants.create` Action" because the key bypasses RLS (the FR-015 blindness risk). This change adds a second use; the invariant must be restated, not broken.
- **Deleting only the `profiles` row is not viable.** The F-01 `profiles_delete` RLS policy (`...identity_boundary.sql:174`, `using (public.is_admin())`) would cascade predictions but leave the `auth.users` row + `user_roles` intact — a still-loginable "ghost" account with no profile. The `auth.users` row must be the deletion root.
- **The admin's own row is already hidden from the list.** `src/pages/admin/participants.astro:22-37` excludes `currentUser.id` from the list and literally anticipates "S-06's future delete control". The list query selects only `display_name, username` — it needs `id` added so a row can be targeted.
- **Action patterns are established.** `src/actions/index.ts`: `requireAdmin(locals)` (line 61), `adminClient(context)` (RLS-respecting SSR client, line 74), `internalError()` (logs server-side, returns a stable generic message, line 38), and the `NOT_CONFIGURED` 500 when a client can't be built. `participants.create` (line 175) is the model for a service-role-backed admin action.
- **There is no runtime isolation test to break.** The service-role single-importer invariant is enforced by the `supabase-admin.ts` banner comment plus grep-style success criteria (S-01 plan), and by `lessons.md` ("phrase secret-isolation criteria against production reads — exclude test files"). No `*.test.ts` asserts importer count.
- **UI stack:** Astro SSR pages + React islands hydrated with `client:*`; forms via `react-hook-form` + shadcn (`ParticipantForm.tsx`). No `alert-dialog` primitive is installed in `src/components/ui/` yet.

## Desired End State

From `/admin/participants`, each listed participant has a "Delete" control. Activating it opens a confirmation that names the participant and warns the action is permanent. On confirm, the participant's `auth.users` row is deleted; their profile, roles, and predictions cascade away; the page reloads and the participant is gone from the list, from the leaderboard, and from every other participant's revealed history. The participant can no longer sign in. The admin can never be deleted (UI hides the admin row; the Action independently refuses any admin-role target). Verify by: deleting a seeded participant who has a scored prediction and confirming they are absent from `profiles`, `predictions`, and `leaderboard`.

### Key Discoveries:

- Cascade root is `auth.users`; `auth.admin.deleteUser(id)` removes everything downstream (`...identity_boundary.sql:18,50`, `...predictions_with_blindness.sql:29`).
- Live views mean zero data-fixup work post-delete (`...results_scoring_leaderboard.sql:99,121`).
- The existing test cleanup already calls `service.auth.admin.deleteUser(data.id)` (`src/actions/participants.test.ts:94`), confirming the call works against the local stack.
- Self-protection must live in the Action, not just the UI — the Action is a public `/_actions/*` endpoint (`src/actions/index.ts:17-25`).

## What We're NOT Doing

- No soft-delete, "deactivate", or audit/tombstone trail (roadmap §2 resolved cascade hard-delete).
- No migration, no new RLS policy, no view changes — the cascade and live views already cover the data side.
- No bulk/multi-select delete — one participant at a time.
- No "undo" / restore flow — the delete is irreversible by design.
- No change to `match_results` (keyed by match, not participant) or to scoring logic.
- No optimistic in-place list update — a full reload re-queries under admin RLS (matches the existing `ParticipantForm` pattern).

## Implementation Approach

Add a `participants.delete` Action that (1) refuses non-admins, (2) reads the target's roles through the RLS-respecting SSR client and refuses any admin-role target, then (3) deletes the `auth.users` row through the isolated service-role client, letting the DB cascade do the rest. Restate the service-role isolation invariant to cover both sanctioned write-only uses. Then wire a per-row delete control in the admin UI behind a shadcn `AlertDialog`, reloading the list on success. Cover the cascade, the admin-refusal, and idempotency with a self-skipping live-DB integration test plus an always-run non-admin guard test.

## Critical Implementation Details

- **Role read on the SSR client, delete on the service-role client.** The target's roles are read via `adminClient(context)` (RLS `user_roles_select` lets the admin read all roles) — NOT the service-role client. This keeps the restated invariant honest: the service-role client is used *only* to write `auth.admin.deleteUser`, never to read per-user data. The `user_roles` trigger always seeds a `participant` row, so **zero role rows ⇒ no such user ⇒ idempotent success** (the participant is already gone).
- **Idempotent already-gone handling.** A stale list or double-submit can target an id that no longer exists. Treat "user not found" (either zero role rows, or a not-found error from `deleteUser`) as success — the end state the caller wants is already true. Do not surface a confusing error.
- **Self-protection is the security crux.** With the single-admin invariant, refusing any `admin`-role target also prevents self-deletion and pool lockout. This guard must run server-side regardless of what the UI shows.

## Phase 1: Delete Action + service-role invariant restatement

### Overview

Add the validation schema and the `participants.delete` Action, and restate the service-role isolation banner to reflect two sanctioned write-only uses.

### Changes Required:

#### 1. Delete input schema

**File**: `src/lib/schemas/participant.ts`

**Intent**: Add a minimal schema validating the delete target id so the Action gets the same zod-validated input pipeline as every other action.

**Contract**: Export `participantDeleteSchema = z.object({ id: z.uuid() })` (top-level `z.uuid()` per the zod-v4 codebase convention — `result.ts:14`, `prediction.ts:15`, `match.ts:57`) and its inferred `ParticipantDeleteInput` type, alongside the existing `participantCreateSchema`.

#### 2. `participants.delete` Action

**File**: `src/actions/index.ts`

**Intent**: Admin-only participant deletion (FR-004). Refuse non-admins; refuse deleting any admin-role user (protects the single admin from lockout, covering self); then delete the `auth.users` row via the isolated service-role client so profile, roles, and predictions cascade. Idempotent on an already-deleted target.

**Contract**: Add `delete` under the existing `participants:` group in `server`. `accept: "json"`, `input: participantDeleteSchema`. Handler sequence (ordering is load-bearing):
1. `requireAdmin(context.locals)`.
2. `const supabase = adminClient(context)` — RLS session client; read `user_roles.role` for `eq("user_id", input.id)`. On read error → `internalError`. **Zero rows → return `{ ok: true }`** (idempotent: no such user). If any row is `'admin'` → `throw new ActionError({ code: "FORBIDDEN", message: "You can't delete an admin account." })`.
3. `const admin = createAdminAuthClient(); if (!admin) throw … NOT_CONFIGURED` (500), mirroring `participants.create`.
4. `const { error } = await admin.auth.admin.deleteUser(input.id)` — the bare call, which defaults to `shouldSoftDelete = false` (a HARD delete). This is load-bearing: a soft delete keeps the `auth.users` row, so the `ON DELETE CASCADE` to profiles/predictions would NOT fire and the participant would linger on the leaderboard. NEVER pass `shouldSoftDelete: true`. Idempotency is already handled upstream by step 2 (zero role rows → early `{ ok: true }`), so by the time `deleteUser` runs the target genuinely existed a moment ago; any `error` here is an unexpected fault → `internalError` (the rare delete-between-read-and-delete race still leaves the data consistent). On success return `{ ok: true }`.

The service-role client is used ONLY for the `deleteUser` write — the role read is on the SSR client.

#### 3. Restate the service-role isolation invariant

**File**: `src/lib/supabase-admin.ts`

**Intent**: Update the banner comment so the invariant accommodates the legitimate second writer without losing the FR-015 guarantee.

**Contract**: Rewrite the "exactly ONE importer" wording to: the service-role client is used ONLY for `auth.admin` **write** operations (`createUser`, `deleteUser`) from `participants.create` / `participants.delete`, and must NEVER read per-user data (predictions, profiles, roles). Keep the FR-015 rationale.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Unit/integration tests pass: `npm test`
- Service-role key remains read in exactly one production module: `rg "SUPABASE_SERVICE_ROLE_KEY" src --glob '!*.test.*'` returns only `src/lib/supabase-admin.ts`
- `createAdminAuthClient` has exactly the two sanctioned importers (both write-only): `rg "createAdminAuthClient" src --glob '!*.test.*'` returns only `src/lib/supabase-admin.ts` (definition) and `src/actions/index.ts` (create + delete)

#### Manual Verification:

- Calling the delete Action as a non-admin returns UNAUTHORIZED
- Calling the delete Action with an admin-role target returns FORBIDDEN
- Deleting an already-removed id succeeds without error (idempotent)

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Admin UI — delete control

### Overview

Surface a per-row delete control on `/admin/participants`, gated behind a confirmation dialog, reloading the list on success.

### Changes Required:

#### 1. List query exposes the row id

**File**: `src/pages/admin/participants.astro`

**Intent**: Include each participant's `id` so a row can be targeted for deletion, and pass it to the new delete control. The admin's own row stays excluded (existing `.neq("id", currentUser.id)`).

**Contract**: Add `id` to the `.select(...)`; extend `ParticipantRow` with `id: string`; render a `DeleteParticipantButton` island in a new table cell per row, passed `id` and `displayName`.

#### 2. Confirmation primitive

**File**: `src/components/ui/alert-dialog.tsx` (new, generated)

**Intent**: Provide an accessible, focus-trapped confirmation dialog for the destructive action.

**Contract**: Add via `npx shadcn@latest add alert-dialog` (new-york variant). Do not hand-author. May transitively pull additional ui primitives — note any in the diff (per `lessons.md`).

#### 3. Delete control island

**File**: `src/components/admin/DeleteParticipantButton.tsx` (new)

**Intent**: A per-row React island that confirms the destructive delete (naming the participant, warning it is permanent), calls the Action, and reloads the list on success.

**Contract**: Props `{ id: string; displayName: string }`. Renders a destructive "Delete" trigger opening an `AlertDialog` ("Delete {displayName}? This permanently removes their account, predictions, and points. This can't be undone."). Confirm calls `actions.participants.delete({ id })`; on `error`, show `error.message` and keep the dialog; on success, `window.location.reload()` (mirrors `ParticipantForm` `handleReset`). Disable the confirm button while submitting. Hydrate with `client:load` from the `.astro` page.

### Success Criteria:

#### Automated Verification:

- Type checking + lint pass: `npm run lint`
- Build passes: `npm run build`
- `alert-dialog` primitive exists: `src/components/ui/alert-dialog.tsx` present

#### Manual Verification:

- Each non-admin participant row shows a Delete control; the admin's own row is absent
- Confirming a delete removes the participant from the list after reload
- The deleted participant no longer appears on `/leaderboard` and their revealed history is gone
- The deleted participant can no longer sign in
- Cancelling the dialog leaves the participant untouched
- An action error surfaces a readable message without leaking raw DB text

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 3: Tests

### Overview

Prove the cascade, the admin-refusal guard, and idempotency, without making the default `npm test`/CI gate depend on a live Supabase stack.

### Changes Required:

#### 1. Non-admin guard (always runs)

**File**: `src/actions/participants.test.ts`

**Intent**: Extend the existing always-run guard lane so a non-admin caller is refused before any DB work — mirrors the `participants.create` admin-guard test.

**Contract**: Reach `server.participants.delete.handler` via the same narrow-contract pattern already in the file; assert a `participant`-only caller rejects with `{ code: "UNAUTHORIZED" }`.

#### 2. Live-DB cascade + guard + idempotency (self-skipping)

**File**: `src/actions/participants.test.ts`

**Intent**: In the existing `describe.skipIf(!dbConfigured)` live lane, prove the end-to-end delete: cascade removal, refusing an admin target, and idempotent re-delete.

**Contract**: Within the live lane:
- Create a participant (reuse the `create` helper), look up their `id`, seed a prediction, seed a `match_results` row for that match (post-kickoff), and confirm the participant appears in `leaderboard`. Then call the `delete` handler as admin and assert: their `auth.users` row is gone (e.g. `admin.auth.admin.getUserById(id)` returns no user — proving a HARD delete, not a soft delete), their `profiles` row is gone, their `predictions` rows are gone, and they are absent from `leaderboard`.
- Assert deleting the seeded admin's id rejects with `{ code: "FORBIDDEN" }` (and the admin row still exists).
- Assert a second delete of the same (now-removed) id resolves to `{ ok: true }` (idempotent).
- Use the service client for setup/teardown as the file already does; track created ids for `afterAll` cleanup.

### Success Criteria:

#### Automated Verification:

- Default gate stays green without a DB: `npm test` (live lane self-skips; guard test runs)
- Lint passes: `npm run lint`
- With a local stack configured, the live lane passes: `SUPABASE_DB_URL=… SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… npm test -- participants`

#### Manual Verification:

- Running the live lane against the local Supabase stack shows the cascade, FORBIDDEN, and idempotency assertions passing

---

## Testing Strategy

### Unit Tests:

- `participantDeleteSchema` rejects a non-uuid id (implicitly exercised through the schema-validated handler call).
- Non-admin caller → UNAUTHORIZED (mockable, always runs).

### Integration Tests:

- Create → predict → result → delete → assert absence from `profiles`, `predictions`, and `leaderboard` (live DB).
- Delete an admin-role target → FORBIDDEN; admin still present.
- Re-delete a removed id → idempotent `{ ok: true }`.

### Manual Testing Steps:

1. As admin, open `/admin/participants`; confirm each non-admin row has a Delete control and the admin row does not.
2. Delete a participant who has at least one scored prediction; confirm the reload removes them from the list.
3. Open `/leaderboard` and that participant's history surface; confirm they are gone.
4. Attempt to sign in as the deleted participant; confirm it fails.
5. Cancel a delete dialog; confirm no change.

## Performance Considerations

Negligible — a single auth-admin delete plus a cascade over a 5–20 row pool. Views are read-time but already in use; no new query cost.

## Migration Notes

None. No schema, RLS, or view changes — the cascade FKs and live views from F-01/S-03/S-04 already cover the data side. (Per the AGENTS.md approval gate, dropping/altering tables needs human sign-off; this change adds none.)

## References

- Roadmap slice: `context/foundation/roadmap.md` S-06 (`### S-06: Admin deletes a participant`), Open Roadmap Questions §2 (cascade-delete resolution)
- Cascade FKs: `supabase/migrations/20260528232000_identity_boundary.sql:18,50`, `supabase/migrations/20260604184657_predictions_with_blindness.sql:29`
- Live views: `supabase/migrations/20260605052647_results_scoring_leaderboard.sql:99,121`
- Service-role client: `src/lib/supabase-admin.ts:19`
- Action patterns: `src/actions/index.ts:61,74,175` (`requireAdmin`, `adminClient`, `participants.create`)
- Admin list (self-exclusion + S-06 anticipation): `src/pages/admin/participants.astro:22-37`
- Test patterns + working `deleteUser` call: `src/actions/participants.test.ts:69,94`
- Isolation criteria phrasing: `context/foundation/lessons.md` (production-read isolation note)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Delete Action + service-role invariant restatement

#### Automated

- [x] 1.1 Type checking passes: `npm run lint` — 26361e3
- [x] 1.2 Unit/integration tests pass: `npm test` — 26361e3
- [x] 1.3 `SUPABASE_SERVICE_ROLE_KEY` read in exactly one production module (`rg … --glob '!*.test.*'` → only `src/lib/supabase-admin.ts`) — 26361e3
- [x] 1.4 `createAdminAuthClient` has exactly the two sanctioned write-only importers (`rg … --glob '!*.test.*'` → `supabase-admin.ts` def + `src/actions/index.ts`) — 26361e3

#### Manual

- [x] 1.5 Non-admin delete call returns UNAUTHORIZED — 26361e3
- [x] 1.6 Admin-role target returns FORBIDDEN — 26361e3
- [x] 1.7 Deleting an already-removed id succeeds (idempotent) — 26361e3

### Phase 2: Admin UI — delete control

#### Automated

- [x] 2.1 Type checking + lint pass: `npm run lint` — 01ea64b
- [x] 2.2 Build passes: `npm run build` — 01ea64b
- [x] 2.3 `src/components/ui/alert-dialog.tsx` present — 01ea64b

#### Manual

- [x] 2.4 Each non-admin row shows Delete; admin row absent — 01ea64b
- [x] 2.5 Confirming a delete removes the participant after reload — 01ea64b
- [x] 2.6 Deleted participant absent from `/leaderboard` and revealed history — 01ea64b
- [x] 2.7 Deleted participant can no longer sign in — 01ea64b
- [x] 2.8 Cancelling the dialog leaves the participant untouched — 01ea64b
- [x] 2.9 Action error surfaces a readable message, no raw DB text — 01ea64b

### Phase 3: Tests

#### Automated

- [x] 3.1 Default gate green without a DB: `npm test` (live lane self-skips, guard runs) — c119baa
- [x] 3.2 Lint passes: `npm run lint` — c119baa
- [x] 3.3 Live lane passes with a local stack: `… npm test -- participants` — c119baa

#### Manual

- [x] 3.4 Live lane against local Supabase shows cascade + FORBIDDEN + idempotency passing — c119baa
