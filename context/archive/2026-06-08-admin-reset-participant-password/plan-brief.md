# Admin Resets a Participant's Password (S-09) — Plan Brief

> Full plan: `context/changes/admin-reset-participant-password/plan.md`
> Research: `context/changes/admin-reset-participant-password/research.md`

## What & Why

Give the single admin a one-click "Reset password" control on `/admin/participants` (FR-024). The system generates a temporary password, sets it on the target, revokes the target's existing sessions, and reveals the temp password once for out-of-band sharing — the same handoff model as the S-01 initial password. The participant then self-rotates it on `/settings` (FR-003). This completes the admin-set-password lifecycle: create (S-01) → reset (S-09) → self-change (S-07).

## Starting Point

Every pattern already exists. `participants.create` (S-01) gives the service-role client (`createAdminAuthClient`), the `generatePassword` helper, and the reveal-once UI; `participants.delete` (S-06) gives the per-row `AlertDialog` confirm and the RLS target-role check that refuses admin targets. The only gap: the Supabase SDK has **no by-user-id sign-out**, and an admin password-set isn't documented to revoke sessions — so revocation needs a new, explicit primitive.

## Desired End State

Admin clicks "Reset password" on a row → confirms → a temp password is revealed (with Copy) inside the dialog. The participant's old password and active sessions stop working; they sign in with the temp password and change it on `/settings`. Resetting an admin target is refused; non-admins can't reach the action.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Password set | `auth.admin.updateUserById({ password })` on the service-role client | The sanctioned, typed admin API confirmed in the installed SDK. | Research |
| Session revocation | `updateUserById` + a `SECURITY DEFINER` RPC (`revoke_user_sessions`) clearing the target's `auth.sessions` | SDK has no by-user-id sign-out and PostgREST doesn't expose `auth`; an RPC makes revocation deterministic and verifiable. | Plan |
| Revocation bar | Refresh-token revocation (not access-token) | Matches the guarantee `account.changePassword` already ships and tests. | Research |
| Admin-target guard | Refuse `admin` targets with `FORBIDDEN` | Symmetric with delete; the single admin rotates via `/settings`. | Plan |
| Reveal UX | Inside the confirm `AlertDialog` (reveal after confirm, reload on dismiss) | Keeps per-row context; mirrors delete's stay-open + reveal-once deferred reload. | Plan |
| Handler ordering | Set password first, then revoke; revoke failure throws (password not revealed) | A half-done reset must fail loudly and be safely retried, never silently leave sessions alive. | Plan |
| Tests | Two-lane harness + isolation-guard confirmation | Proves FR-024 end-to-end while keeping CI green without a DB. | Plan |

## Scope

**In scope:** a `public.revoke_user_sessions(uuid)` migration; the `participants.resetPassword` action + `{ id }` schema; the `supabase-admin.ts` banner update; a per-row `ResetPasswordButton` island wired into `participants.astro`; unit + integration tests + isolation-guard confirmation.

**Out of scope:** forced change-on-next-login; email/notification reset; admin-typed passwords; resetting the admin's own account; bulk reset / reset history / audit trail; access-token lifetime or middleware changes; a second importer of the service-role client.

## Architecture / Approach

Per-row island → `actions.participants.resetPassword({ id })` → `requireAdmin` + RLS role-read (refuse admin) → service-role `updateUserById({ password: generatePassword() })` → service-role `rpc("revoke_user_sessions", { target: id })` → return `{ password }` once. The revoke function is `public`-schema, `SECURITY DEFINER`, granted to `service_role` only. The service-role client stays auth-only; the new RPC call lives in `actions/index.ts` (the existing sole importer), so the isolation guard is unaffected.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Data layer | `revoke_user_sessions` function + grants + regenerated types | `auth.sessions` delete must actually invalidate refresh tokens (verified manually + by the live test) |
| 2. Server layer | `resetPassword` action + schema + banner update | Handler ordering (set-then-revoke; revoke failure throws) |
| 3. UI layer | Per-row `ResetPasswordButton` (confirm → reveal-once → reload on dismiss) | Not auto-reloading on success (password is shown once) |
| 4. Tests + guard | Two-lane harness (old-fails/temp-works/refresh-revoked) + isolation guard | Refresh-revocation assertion flakiness; keeping CI green without a DB |

**Prerequisites:** S-01 (`done`) and F-01 (`done`); local Supabase stack for the live test; `SUPABASE_SERVICE_ROLE_KEY` in `.dev.vars`.
**Estimated effort:** ~1–2 sessions across 4 small phases.

## Open Risks & Assumptions

- Assumes deleting `auth.sessions` rows invalidates the target's refresh tokens (GoTrue's documented logout behavior) — pinned by the Phase 4 live test and a Phase 1 manual check.
- Revocation covers refresh tokens; an already-issued access token remains valid until expiry (≤1h), which BetCup's middleware does not separately validate — same posture as the shipped `account.changePassword`.
- The function reads GoTrue's `auth.sessions`; a future GoTrue schema change would surface here and in the revocation test.

## Success Criteria (Summary)

- Admin resets any non-admin participant in one click and shares a generated temp password revealed exactly once.
- The participant's old password and existing sessions stop working; the temp password works and is self-rotatable on `/settings`.
- `lint` + `build` + `check:wrangler` + `npm test` pass; the live test proves old-fails/temp-works/refresh-revoked; the service-role isolation guard stays green.
