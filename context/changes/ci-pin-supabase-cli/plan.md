# CI `rls` Gate Fix — Deterministic Admin Seed + Pinned Supabase CLI Implementation Plan

## Overview

The `rls` CI job went red (`permission denied for table tournaments` in the
`beforeAll` of all four `*.rls.test.ts` suites) because the seeded admin user is
created but never granted the `admin` role. We make admin promotion deterministic
in the seed (an explicit `user_roles` insert that does not depend on a session
GUC reaching the `handle_new_user` trigger), then pin the Supabase CLI in CI so
the gate is reproducible.

## Current State Analysis

- CI boots a real Supabase stack and runs the four live-DB RLS suites
  (`.github/workflows/ci.yml:86-116`). It pins the toolchain loosely:
  `supabase/setup-cli@v1` with `version: latest` (`ci.yml:98-100`).
- Local admin promotion has exactly **one** path: `supabase/seed.sql.template:15`
  sets `app.admin_email` via session-scoped `set_config(..., false)`, then the
  `handle_new_user` trigger reads `current_setting('app.admin_email', true)` and
  inserts an `admin` `user_roles` row only if the email matches
  (`supabase/migrations/20260604153800_participant_username.sql:45,63-66`).
- `current_setting(..., true)` (missing_ok) returns NULL when the GUC isn't
  visible → the admin branch is silently skipped, no error. The failure only
  surfaces later as `permission denied` at the admin-only `tournaments_insert`
  policy (`supabase/migrations/20260602180000_tournament_and_matches.sql:74-77`).
- `seed.sql.template:59` uses `on conflict do nothing`, so a re-seed never
  repairs an already-created-but-unpromoted admin.
- No migration, CI step, package script, config default, or RLS test fixture
  provides a promotion fallback — the same-session `set_config` is the sole point
  of failure (see `frame.md` Hypothesis Investigation).

### Key Discoveries:

- The newer Supabase CLI moved core commands onto a TypeScript shell with a
  `pgx.Batch` internal seed runner that changed how `seed.sql` statements
  execute, breaking the same-session GUC→trigger assumption (frame.md References;
  CLI v2.105.0 2026-06-04 → v2.107.0 2026-06-17). Local **2.98.2** passes all 57
  RLS tests; CI `latest` (now v2.107.0) fails before any test code runs.
- The seed already executes in a **privileged** context (it inserts directly into
  `auth.users`, bypassing RLS), so it can insert into `public.user_roles`
  directly too. `user_roles` has `UNIQUE(user_id, role)`, so an explicit insert
  with `on conflict do nothing` is safe and dedupes against the trigger.
- Production admin bootstrap uses a sturdier path (`ALTER DATABASE postgres SET
app.admin_email` under a privileged connection — `README.md:147`); local/CI is
  the fragile outlier. This change only touches local/CI seeding.

## Desired End State

The `rls` CI gate passes on the PR. Admin promotion in local/CI no longer
depends on the session-GUC→trigger timing: a fresh `supabase start` (CI) or
`supabase db reset` (local) deterministically yields an admin with the `admin`
role under any CLI version. The CLI is pinned to a known-good version so the gate
is reproducible. Verify by: (a) the PR's `rls` job is green; (b) locally,
`npm run db:reset` then `npm test -- rls` is green.

## What We're NOT Doing

- **No change to `handle_new_user` or any migration / RLS policy.** This is a
  seed + CI fix only. The seeded role insert restates trigger intent in the seed;
  it does not alter the trigger (that would be the larger, prod-affecting
  redesign we explicitly rejected during framing).
- **No production bootstrap change.** `README.md:147` `ALTER DATABASE` path is
  untouched.
- **Not removing `set_config` / the trigger path.** It stays as a harmless,
  deduped fallback.
- **Not fixing the unrelated `results-scoring.rls.test.ts` supabase-js WebSocket
  issue** documented in test-plan §6.6 (its own future change).
- **Not bumping `supabase/setup-cli` from `@v1` to `@v2`** (out of scope).

## Implementation Approach

Land the root fix first (seed), then the reproducibility hardening (pin + docs).
The seed fix alone re-greens CI regardless of CLI version; the pin is
belt-and-suspenders for gate determinism (test-plan Risk #6, local↔CI drift).

## Phase 1: Deterministic admin-seed fix

### Overview

Make the seed grant the admin role explicitly, independent of whether the
trigger observed `app.admin_email` in-session.

### Changes Required:

#### 1. Admin role seed

**File**: `supabase/seed.sql.template`

**Intent**: After the existing `auth.users` / `auth.identities` block, add an
explicit insert of the admin `user_roles` row so promotion no longer depends on
the session GUC reaching the trigger. Keep the existing `set_config` + trigger
path as a deduped fallback. Update the file's header comment to explain that the
explicit insert is the deterministic promotion and the `set_config` is now a
best-effort fallback (so the next reader doesn't "simplify" it away).

**Contract**: A new statement, deterministic and re-run-safe, after the
identities insert (`seed.sql.template:80`):

```sql
insert into public.user_roles (user_id, role)
select id, 'admin' from auth.users where email = '{{ADMIN_EMAIL}}'
on conflict do nothing;
```

Relies on the seed running as a privileged role (same role that already inserts
into `auth.users`); `on conflict do nothing` matches the existing
`UNIQUE(user_id, role)` constraint and dedupes against the trigger.

### Success Criteria:

#### Automated Verification:

- Generated seed is valid SQL and applies cleanly: `npm run db:reset` succeeds
  with no seed errors.
- Live-DB RLS suites pass locally: `npm test -- rls` (predictions/matches/history
  green; `results-scoring` may still fail only on the unrelated, pre-existing
  supabase-js WebSocket issue noted in test-plan §6.6 — that file's `beforeAll`
  tournament insert must succeed, proving the admin is promoted).
- Lint/type pass: `npm run lint`.

#### Manual Verification:

- After `npm run db:reset`, the admin user has the `admin` role (e.g. query
  `public.user_roles` for the admin user id, or confirm an admin-only insert
  succeeds) — promotion happens even though it no longer depends on trigger
  timing.

**Implementation Note**: After Phase 1 automated verification passes, pause for
manual confirmation before Phase 2.

---

## Phase 2: Pin the CI Supabase CLI + document the fix

### Overview

Pin the gate's CLI to a known-good version and record the fix in the test plan.

### Changes Required:

#### 1. Pin setup-cli version

**File**: `.github/workflows/ci.yml`

**Intent**: Replace `version: latest` in the `rls` job's `supabase/setup-cli@v1`
step with the known-good pinned version, and add a short comment explaining why
(loose `latest` pulled a CLI whose seed runner broke same-session admin
promotion; pin for a reproducible gate).

**Contract**: `ci.yml:100` `version: latest` → `version: 2.98.2` (verified green
locally with the current RLS suite), with an adjacent rationale comment.

#### 2. Record the fix in the test plan

**File**: `context/foundation/test-plan.md`

**Intent**: Add a §6.6 per-change note documenting the root cause (admin
promotion coupled to a session GUC the CLI seed runner no longer guarantees), the
two-part fix (deterministic seed insert + pinned CLI), and the tie to Risk #6
(local↔CI drift). Reference `context/changes/ci-pin-supabase-cli/`.

**Contract**: New dated bullet under §6.6 "Per-rollout-phase notes"
(`test-plan.md:250`). No change to the §3 phase table (this is an infra fix, not
a rollout phase).

### Success Criteria:

#### Automated Verification:

- Workflow file is valid YAML and the pinned version is syntactically correct:
  `npm run lint` passes; `git diff` shows only the intended `version:` + comment
  change in the `rls` job.
- The PR's `rls` CI job passes (the authoritative check — it runs the pinned CLI
  end-to-end against a fresh stack).

#### Manual Verification:

- Confirm on the PR that the `rls` job installed `2.98.2` and went green; the
  admin-promotion `permission denied` error no longer appears in any suite's
  `beforeAll`.

**Implementation Note**: Phase 2's authoritative verification is the PR's `rls`
run; pause for manual confirmation that CI is green before closing the change.

---

## Testing Strategy

### Integration Tests:

- The four live-DB `*.rls.test.ts` suites are the verification surface — their
  shared `beforeAll` admin tournament insert is exactly the assertion that admin
  promotion worked. No new tests are needed; the existing gate proves the fix.

### Manual Testing Steps:

1. `npm run db:reset` (regenerates seed, reapplies migrations + seed) — expect no
   errors.
2. `npm test -- rls` — expect predictions/matches/history green; the `beforeAll`
   tournament insert succeeds everywhere (admin promoted).
3. Confirm the admin user holds the `admin` role in `public.user_roles`.
4. On the PR, confirm the `rls` job ran CLI `2.98.2` and is green.

## Migration Notes

No schema migration. CI runners and local `db:reset` start from a clean state, so
there is no stale `user_roles` data to backfill; `on conflict do nothing` keeps
re-seeds idempotent.

## References

- Frame brief: `context/changes/ci-pin-supabase-cli/frame.md`
- Change notes: `context/changes/ci-pin-supabase-cli/change.md`
- Seed: `supabase/seed.sql.template:6-15,59-80`
- Trigger: `supabase/migrations/20260604153800_participant_username.sql:45,63-66`
- Admin-only policy: `supabase/migrations/20260602180000_tournament_and_matches.sql:74-77`
- CI gate: `.github/workflows/ci.yml:86-116`
- Test plan: `context/foundation/test-plan.md:250` (§6.6), Risk #6 (§3)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Deterministic admin-seed fix

#### Automated

- [x] 1.1 Generated seed applies cleanly: `npm run db:reset` succeeds with no seed errors
- [x] 1.2 Live-DB RLS suites pass locally: `npm test -- rls` (admin promoted; only the unrelated supabase-js WebSocket failure may remain)
- [x] 1.3 Lint/type pass: `npm run lint`

#### Manual

- [x] 1.4 After `npm run db:reset`, admin user holds the `admin` role in `public.user_roles`

### Phase 2: Pin the CI Supabase CLI + document the fix

#### Automated

- [ ] 2.1 Workflow is valid YAML; `git diff` shows only the intended `version:` + comment change; `npm run lint` passes
- [ ] 2.2 The PR's `rls` CI job passes with the pinned CLI

#### Manual

- [ ] 2.3 Confirm on the PR that `rls` installed `2.98.2`, went green, and the admin `permission denied` error is gone from all suites
