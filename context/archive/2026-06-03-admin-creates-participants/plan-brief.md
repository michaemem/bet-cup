# Admin Creates Participants (S-01) — Plan Brief

> Full plan: `context/changes/admin-creates-participants/plan.md`

## What & Why

Give the single admin an in-app way to create participant accounts (FR-001) so those participants can log in (FR-002). Today accounts only come into existence via the F-01 admin seed / Supabase Studio; this slice makes account creation a first-class admin task and switches login from email to username, so the friend group can be onboarded without anyone needing an email address.

## Starting Point

F-01 + S-02 are landed: `profiles` + `user_roles` + RLS + `is_admin()`, and crucially the **`handle_new_user` trigger** that auto-creates a profile + `participant` role on *any* `auth.users` insert. S-02 established the mutation pattern this reuses — Astro Actions with an in-handler admin guard, shared Zod schemas, and react-hook-form islands — plus an admin-gated `/admin/*` area. The Worker holds only the anon key; no service-role key is wired anywhere.

## Desired End State

The admin opens `/admin/participants`, sees existing participants, enters a name + username, and submits. A panel reveals the new participant's username + an auto-generated password to share out-of-band. That participant signs in by username and lands on `/dashboard`. Non-admins can't reach the page or the Action; duplicate usernames get a friendly inline error.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|---|---|---|---|
| Creation mechanism | Service-role `auth.admin.createUser`, isolated in one module | Officially supported & upgrade-safe; avoids reimplementing GoTrue internals (password hash, `auth.identities`) that break login | Plan |
| Login identity | Username only → synthetic `<username>@betcup.local` | Skips emails for a friend group; seeded admin (`admin@betcup.local`) already matches username `admin` | Plan |
| Service-role safety | Single module, single importer, no-session client, never reads predictions | Contains the FR-015 leak risk the roadmap flags | Plan |
| Manage surface | New `/admin/participants` page: create form + read-only list | Matches "creates and manages"; S-06 later just adds a delete button to list rows | Plan |
| Password handoff | Auto-generate a strong password, reveal once (copyable), no auto-reload | Always strong, zero admin effort; reveal panel must persist or the only copy is lost | Plan |
| Username rules | Lowercased, 3–30, `[a-z0-9._-]`, case-insensitive login | Kills `Bob`≠`bob` login bugs; uniqueness via a `lower(username)` unique index | Plan |
| Edge cases | Friendly "username taken", participant-only, trigger guarantees no orphan rows | Predictable UX; preserves the single-admin invariant | Plan |
| Username storage | New `profiles.username` column (trigger-populated) | Lets the list render under admin RLS without a service-role read | Plan |
| Tests | Unit (schema + generator) + integration (create→sign-in; non-admin denied; dup) | Pins FR-001+FR-002 jointly and the admin guard | Plan |

## Scope

**In scope:** `profiles.username` migration + trigger update; service-role env + isolated admin client; password generator; `participant` schema + `synthEmail` helper; `participants.create` Action; username-based sign-in; `/admin/participants` page + `ParticipantForm` island with reveal panel; unit + integration tests.

**Out of scope:** delete (S-06), password change/reset (S-07), editing name/username, second admin / role management, email delivery, re-enabling self-signup.

## Architecture / Approach

Bottom-up, mirroring F-01/S-02: **DB** (username column + trigger + types) → **server** (service-role client + password util + schema + Action + sign-in mapping) → **UI** (username sign-in + `/admin/participants` + reveal island) → **tests**. The service-role key lives in exactly one module imported by exactly one Action and is used only for `createUser`; everything else stays on the anon client under RLS.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|---|---|---|
| 1. Data layer | `profiles.username` (unique, backfilled) + trigger populates it; regen types | Backfill + NOT NULL ordering; trigger re-create must preserve F-01 semantics |
| 2. Server layer | Service-role env + isolated client, password gen, schema, `participants.create`, username sign-in; unit tests | Service-role isolation; identical username→email mapping on both sides |
| 3. UI layer | Username sign-in, `/admin/participants` (list + create), reveal-once island, nav | Reveal panel must persist (no auto-reload) or the password is lost |
| 4. Integration + CI | create→sign-in, non-admin denied, duplicate error; CI stays green | Local-Supabase test lane must skip cleanly in CI without the service-role key |

**Prerequisites:** F-01 (`identity-boundary`) — landed. No other blockers.
**Estimated effort:** ~2–3 focused sessions; Phase 3 (island + reveal UX) and Phase 4 (integration harness) are the heaviest.

## Open Risks & Assumptions

- Introducing a service-role key into the Worker is a new posture vs F-01's deliberate avoidance; safety rests on single-module isolation + a review assertion that no second importer exists.
- The integration test needs a local Supabase + the service-role key; it must skip cleanly in CI so the gate doesn't depend on a DB.
- `betcup.local` synthetic emails assume GoTrue accepts the domain (it does locally — the F-01 seed uses it); verify on hosted Supabase at deploy.
- A future `ADMIN_EMAIL` not under `@betcup.local` relies on the sign-in `@`-passthrough to avoid admin lockout.

## Success Criteria (Summary)

- Admin creates a participant from `/admin/participants`; the participant signs in by username and reaches `/dashboard`.
- A non-admin can neither reach the page nor invoke the Action; a duplicate username shows a friendly inline error.
- `npm run lint`, `npm run build`, `npm run check:wrangler`, and `npm test` all pass.
