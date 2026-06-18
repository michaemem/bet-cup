# CI `rls` Gate Fix — Plan Brief

> Full plan: `context/changes/ci-pin-supabase-cli/plan.md`
> Frame brief: `context/changes/ci-pin-supabase-cli/frame.md`

## What & Why

The `rls` CI gate went red: the seeded admin signs in but isn't granted the
`admin` role, so every suite's `beforeAll` admin tournament insert hits
`permission denied`. Root: local/CI admin promotion is coupled to a session-scoped
`set_config('app.admin_email', …, false)` being visible to the `handle_new_user`
trigger in the same connection — a guarantee the newer Supabase CLI's seed runner
no longer provides. The `version: latest` bump merely exposed the fragility.

## Starting Point

Admin promotion has exactly one path: the seed sets a session GUC, then the
trigger reads it (`current_setting(..., true)` → silently NULL when unset) and
conditionally inserts the `admin` role. CI pins `supabase/setup-cli@v1` to
`version: latest` (`ci.yml:98-100`); local 2.98.2 passes all 57 RLS tests, CI's
current `latest` (v2.107.0) fails before any test code runs.

## Desired End State

A fresh `supabase start` (CI) / `supabase db reset` (local) deterministically
produces an admin with the `admin` role under any CLI version, and the gate runs a
pinned, reproducible CLI. The PR's `rls` job is green; `npm test -- rls` is green
locally.

## Key Decisions Made

| Decision                  | Choice                                            | Why (1 sentence)                                                                   | Source |
| ------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| Problem framing           | Fragile GUC→trigger coupling, exposed by CLI bump | Admin created but unpromoted; sole promotion path is a same-session GUC            | Frame  |
| Solution shape            | Durable seed fix + pin CLI                        | Green now AND robust under any future CLI; pin adds gate reproducibility (Risk #6) | Plan   |
| Durable mechanism         | Seed inserts the admin `user_roles` row directly  | Deterministic, no trigger-timing dependence, no migration/prod impact              | Plan   |
| Keep `set_config`/trigger | Yes, as deduped fallback                          | Harmless; `UNIQUE(user_id, role)` + `on conflict do nothing` dedupes               | Plan   |
| Pin target                | `2.98.2`                                          | Empirically green locally with the current suite                                   | Plan   |

## Scope

**In scope:** explicit admin-role insert in `supabase/seed.sql.template`; pin
`supabase/setup-cli` version in `ci.yml`; document the fix in test-plan §6.6.

**Out of scope:** `handle_new_user`/migrations/RLS policies; production bootstrap;
removing `set_config`; the unrelated `results-scoring` supabase-js WebSocket
issue; bumping `setup-cli` `@v1`→`@v2`.

## Architecture / Approach

Seed runs privileged (it already writes `auth.users`), so it can write
`public.user_roles` directly. Add `insert into public.user_roles (user_id, role)
select id,'admin' from auth.users where email = '{{ADMIN_EMAIL}}' on conflict do
nothing;` after the existing user/identity block. Then pin the gate's CLI. The
seed fix alone re-greens CI; the pin is belt-and-suspenders.

## Phases at a Glance

| Phase                           | What it delivers                             | Key risk                                                                   |
| ------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| 1. Deterministic admin-seed fix | Admin promoted regardless of trigger timing  | Privilege/constraint mismatch in the insert (low)                          |
| 2. Pin CLI + docs               | Reproducible green gate + recorded rationale | Pinned version itself not green in CI (mitigated: 2.98.2 verified locally) |

**Prerequisites:** local Supabase stack runnable (Docker); PR branch with CI.
**Estimated effort:** ~1 session, 2 small phases.

## Open Risks & Assumptions

- Assumes the seed runs as a privileged role in both `supabase start` and `db
reset` (consistent with it already inserting into `auth.users`).
- Pinning to 2.98.2 is older than current 2.107.0; the durable fix makes
  correctness version-independent, so the pin can be advanced later.
- `results-scoring.rls.test.ts` may still fail on the separate supabase-js issue;
  that does not indicate admin promotion failed (its `beforeAll` insert succeeding
  is the signal).

## Success Criteria (Summary)

- The PR's `rls` job is green with CLI 2.98.2; no admin `permission denied` in any
  suite's `beforeAll`.
- Locally, `npm run db:reset` + `npm test -- rls` pass; admin holds the `admin`
  role.
