# Delete Participant (S-06) — Plan Brief

> Full plan: `context/changes/delete-participant/plan.md`

## What & Why

Let the admin remove a participant from `/admin/participants` so their predictions and earned points disappear from every other participant's revealed history and from the leaderboard, and they can no longer log in (FR-004). The roadmap already resolved the shape: **cascade hard-delete** — no soft-delete, no audit trail (Open Roadmap Questions §2).

## Starting Point

The deletion plumbing already exists: `auth.users → profiles → predictions` are chained with `ON DELETE CASCADE`, and `leaderboard`/`prediction_scores` are live `security_invoker` views. The `/admin/participants` page lists participants (excluding the admin's own row) and creates them via a service-role-backed Action. No delete UI or Action exists yet.

## Desired End State

Each non-admin participant row has a Delete control behind a confirmation dialog. Confirming deletes the participant's `auth.users` row; the profile, roles, and predictions cascade away; the page reloads and they are gone from the list, the leaderboard, and others' history. The admin can never be deleted.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Delete shape | Cascade hard-delete | Roadmap-resolved; no soft-delete in MVP scope | Roadmap |
| Deletion root | Service-role `auth.admin.deleteUser(id)` | One call removes the auth user; profile/roles/predictions cascade; no loginable ghost | Plan |
| Service-role invariant | Restate to "auth user management only — create + delete, never reads" | Accommodates the second writer while preserving the FR-015 no-privileged-reads guarantee | Plan |
| Self-protection | Action refuses any admin-role target (covers self) | The Action is a public endpoint; UI hiding the admin row isn't enough to prevent lockout | Plan |
| Role lookup client | RLS session client (not service-role) | Keeps the service-role client write-only, honoring the restated invariant | Plan |
| Already-gone handling | Idempotent success | A stale list / double-submit shouldn't surface a confusing error | Plan |
| Confirmation UX | shadcn `AlertDialog` naming the participant | Accessible, focus-trapped, matches the existing shadcn/island pattern | Plan |
| List refresh | Full page reload | Re-queries under admin RLS; mirrors `ParticipantForm` | Plan |
| Tests | Self-skipping live-DB cascade test + always-run non-admin guard | Proves the cascade/guard/idempotency without making CI need a DB | Plan |

## Scope

**In scope:** `participants.delete` Action; service-role invariant restatement; per-row delete UI with confirmation; cascade/guard/idempotency tests.

**Out of scope:** migrations, new RLS/views, soft-delete/undo, bulk delete, `match_results`/scoring changes, optimistic list updates.

## Architecture / Approach

`DeleteParticipantButton` island → `actions.participants.delete({ id })`. The Action: `requireAdmin` → read target roles via the RLS session client and refuse any admin → `createAdminAuthClient().auth.admin.deleteUser(id)` (idempotent). The DB cascade removes profile/roles/predictions; live views drop the participant on next read; the page reloads.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Delete Action + invariant | Server-side delete with guards; restated service-role banner | Misusing the service-role client for reads (FR-015); weak self-protection |
| 2. Admin UI | Per-row delete behind a confirmation dialog | Destructive misclick; new `alert-dialog` primitive pulls transitive deps |
| 3. Tests | Cascade + FORBIDDEN + idempotency coverage | Live lane must self-skip so CI stays green without a DB |

**Prerequisites:** S-01 + S-04 landed (both `done`). Local Supabase stack only needed to run the live test lane.
**Estimated effort:** ~1 session across 3 phases.

## Open Risks & Assumptions

- Assumes `auth.admin.deleteUser` cascades through `profiles` as designed (confirmed by FK definitions + existing test-cleanup usage).
- Adding a second service-role use is a deliberate, reviewed widening of a load-bearing security invariant — the restated "write-only, never reads" framing is the guard.

## Success Criteria (Summary)

- Admin deletes a participant and they vanish from the list, the leaderboard, and others' revealed history, and can no longer sign in.
- The admin can never be deleted (FORBIDDEN), even via a crafted request.
- Default `npm test`/CI stays green without a live DB; the live lane proves the cascade.
