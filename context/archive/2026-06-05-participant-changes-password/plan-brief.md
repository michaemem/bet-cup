# Account Settings: Change Password & Display Name — Plan Brief

> Full plan: `context/changes/participant-changes-password/plan.md`
> Research: `context/changes/participant-changes-password/research.md`

## What & Why

Give every logged-in user (participant **and** admin) a `/settings` page to change their own **password** (FR-003) and their **display name** — the name shown on the leaderboard and in other participants' history. The admin-set initial-password handoff is incomplete without self-service rotation, and participants need to control how their name appears to the pool.

## Starting Point

No settings page exists; `dashboard.astro` is the only authenticated hub. Password change is unimplemented (`updateUser` used nowhere). Display-name change is unimplemented but the DB is already ready — `profiles_update` RLS lets a user update their own row. Display name is read-through everywhere (leaderboard view, `profiles_public`, dashboard, history), so one update propagates automatically.

## Desired End State

A user opens `/settings` (linked from the dashboard) and sees two cards. Editing the display name (pre-filled) + confirming the current password updates it across the app. Changing the password + confirming the current password updates it, signs out other devices, and keeps the current one. Both forms show inline errors and a success message, then reload. PRD + roadmap describe this role-agnostic behavior.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Backend lane | Astro Actions (`account` group) + RHF + zod | Matches every in-session mutation; `sessionClient()` already wires the authed client. | Research |
| Current-password check | Re-`signInWithPassword` before any change | `secure_password_change = false`, so we verify ourselves; self-contained, no config flip. | Research + Plan |
| Display-name change guard | Also requires current password | User-chosen; treats name change as a sensitive account action. | Plan |
| Other sessions on password change | Sign out others (`scope: "others"`), keep current | Security hygiene without logging the actor out. | Plan |
| Settings layout | One `/settings` page, two sections | Single discoverable surface; matches roadmap wording. | Plan |
| Success UX | Inline message + reload | No toast infra; matches existing form convention. | Plan |
| DB changes | None | `profiles_update` RLS + `auth.users` update already suffice. | Research |
| Docs | Generalize FR-003 + add FR-023 + expand S-07 | Record the role-agnostic, display-name-inclusive scope. | Plan |

## Scope

**In scope:** `/settings` page; change-password and change-display-name actions + forms; current-password verification; other-session sign-out on password change; dashboard nav link; PRD + roadmap updates; unit + integration tests.

**Out of scope:** lost-password/email recovery; admin resetting another user's password; username (login handle) editing; display-name uniqueness; DB migration / RLS change; `secure_password_change` config flip; toast library.

## Architecture / Approach

Two independent Astro Actions under a new `account` group, both via `sessionClient()`. A shared `verifyCurrentPassword` helper re-signs-in and maps failure to a `currentPassword` field error. `changeDisplayName` then runs `profiles.update({ display_name }).eq("id", user.id)` (sends only that column). `changePassword` runs verify → `updateUser({ password })` → `signOut({ scope: "others" })` in that order. UI is two RHF + shadcn islands on one Astro page; reads propagate to all name surfaces automatically.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Schemas + Actions | `account.ts` schemas + `account.{changePassword,changeDisplayName}` with verification + tests | Password-change call ordering (verify → update → signOut others) |
| 2. Settings UI | `/settings` page + two RHF islands + dashboard link | Field-error mapping + pre-filled name + reload UX |
| 3. Docs | FR-003 generalized, FR-023 added, S-07 expanded | Keeping PRD/roadmap consistent with shipped behavior |

**Prerequisites:** F-01 (done). Local Supabase stack for integration tests.
**Estimated effort:** ~1–2 sessions across 3 phases.

## Open Risks & Assumptions

- `profiles_update` is column-agnostic; the action must send only `{ display_name }` to avoid drifting `username`/`legal_name`.
- `signOut({ scope: "others" })` must run *after* `updateUser` and never with global scope, or the acting user is logged out mid-flow.
- `user.email` is assumed present for a signed-in user (synthetic or admin email); handled defensively.
- Requiring the current password for a display-name change is heavier UX than typical — accepted per decision.

## Success Criteria (Summary)

- A participant and the admin can each change their password (old stops working, other devices signed out, current stays) and their display name (propagates to dashboard, leaderboard, history) from `/settings`.
- Wrong current password and invalid inputs surface inline, never as raw auth errors.
- PRD FR-003/FR-023 and roadmap S-07 match the shipped behavior.
