# CI `rls` Gate Fix — Pin Supabase CLI to 2.98.2 Implementation Plan

> **Diagnosis corrected during implementation.** The original frame attributed the
> red `rls` gate to fragile admin-seed promotion. Local reproduction under CLI
> v2.107.0 disproved that: the admin **is** promoted; the failure is a JWT
> signing-key change in the newer CLI. See "Current State Analysis" and the
> correction note in `frame.md`. This plan is now a **pin-only** fix.

## Overview

The `rls` CI job went red (`permission denied for table tournaments` in the
`beforeAll` of all four `*.rls.test.ts` suites). Root cause: `supabase/setup-cli`
was unpinned (`version: latest`), so CI pulled CLI **v2.107.0**, which defaults the
local stack to **asymmetric ES256 JWT signing keys**. The RLS test harness'
authenticated requests are not validated as authenticated under that scheme —
PostgREST falls back to the `anon` role, which lacks the table INSERT grant, so
every admin-only write fails with a Postgres 42501 `permission denied`. We pin the
CLI to **2.98.2** (legacy HS256 shared secret), which the suites rely on.

## Current State Analysis

- CI boots a real Supabase stack and runs the four live-DB RLS suites
  (`.github/workflows/ci.yml:86-122`), pinning the toolchain loosely:
  `supabase/setup-cli@v1` with `version: latest` (`ci.yml:98-100`).
- Reproduced locally (this machine): **2.98.2 → 57/57 pass; 2.107.0 → 4 suites
  fail** with the identical `permission denied for table tournaments`. Same seed,
  same commands — a clean bisect on CLI version.
- Under 2.107.0, after seeding, the admin user **holds the `admin` role** in
  `public.user_roles` (verified by direct query) — promotion is fine. The
  admin's access token is signed **`alg: ES256`** (asymmetric signing keys, a new
  2.107.0 local default; 2.98.2 issues HS256).
- The failure is Postgres error **42501** (`permission denied for table
tournaments`), a _grant_-level error → the request executes as `anon`, not as a
  non-admin authenticated user (which would instead be an RLS-policy violation).
  This confirms the authenticated session is lost at the PostgREST/JWT boundary.

### Key Discoveries:

- The admin-seed promotion the frame suspected was never broken. The earlier
  local "green" with a seed change was misleading: under 2.98.2 the trigger
  promotes the admin regardless, so a seed-level change had no observable effect.
- `config.toml` has no clean toggle to force legacy HS256 on a newer CLI (only
  `signing_keys_path` to _supply_ asymmetric keys — `config.toml:161-162`), so
  "stay on latest" would require adapting the test harness to ES256. Out of scope
  here.
- Last green `main` `rls` run was 2026-06-09 under an older (HS256) CLI; PR #24
  was the first to pull a newer CLI via `latest`.

## Desired End State

The `rls` CI gate passes because CI installs CLI **2.98.2** (HS256). Local and CI
agree (`npm test -- rls` → 57/57). The seed template is unchanged from `main`. A
test-plan note records the cause and the pin so the next reader understands why
`latest` is avoided and when the pin may be lifted.

## What We're NOT Doing

- **No seed change.** The Phase-1 seed edit (committed in `4247271`) is reverted;
  promotion was never the problem.
- **No `handle_new_user` / migration / RLS policy change.**
- **No test-harness change to support ES256** (the "fix forward" alternative) —
  deferred; tracked as the pin's lift condition.
- **No `setup-cli` `@v1`→`@v2` bump.**
- **No production bootstrap change.**

## Implementation Approach

Single phase: revert the seed edit, pin the CLI, document the cause. Verified
locally by running the suite against the pinned 2.98.2 stack; CI's `rls` job is
the authoritative confirmation.

## Phase 1: Pin the CLI to 2.98.2, revert the seed, document

### Overview

Make CI deterministic on a known-good (HS256) CLI and record why.

### Changes Required:

#### 1. Revert the seed template

**File**: `supabase/seed.sql.template`

**Intent**: Restore the original `main` seed (session `set_config` + CTE insert);
the durable-seed experiment was based on the wrong diagnosis and is unnecessary.

**Contract**: File content identical to `4247271^:supabase/seed.sql.template`.

#### 2. Pin setup-cli version

**File**: `.github/workflows/ci.yml`

**Intent**: Replace `version: latest` in the `rls` job with `2.98.2`, plus a
comment explaining the ES256/HS256 cause and the pin's lift condition.

**Contract**: `ci.yml` `rls` job `supabase/setup-cli@v1` → `version: 2.98.2`.

#### 3. Record the diagnosis in the test plan

**File**: `context/foundation/test-plan.md`

**Intent**: Add a §6.6 note: CLI `latest` (>= v2.107.0) switched the local stack
to ES256 signing keys → authenticated RLS requests fall back to `anon` →
`permission denied`; fixed by pinning to 2.98.2 (HS256). Tie to Risk #6
(local↔CI drift) and reference `context/changes/ci-pin-supabase-cli/`.

**Contract**: New dated bullet under §6.6 (`test-plan.md:250`). No §3 phase-table
change (infra fix, not a rollout phase).

### Success Criteria:

#### Automated Verification:

- `git diff` shows `supabase/seed.sql.template` identical to `main` (seed revert
  clean): `git diff --stat 4247271^ -- supabase/seed.sql.template` is empty.
- Workflow is valid YAML; `npm run lint` passes.
- Live-DB RLS suites pass locally against the pinned 2.98.2 stack:
  `npm test -- rls` → 57/57.
- The PR's `rls` CI job passes with CLI 2.98.2.

#### Manual Verification:

- Confirm on the PR that the `rls` job installed `2.98.2`, went green, and the
  `permission denied for table tournaments` error is gone from all suites.

**Implementation Note**: Phase 1's authoritative verification is the PR's `rls`
run; pause for manual confirmation that CI is green before closing the change.

---

## Testing Strategy

### Integration Tests:

- The four live-DB `*.rls.test.ts` suites are the verification surface — their
  shared `beforeAll` admin tournament insert is exactly the assertion that the
  authenticated admin session is honored. No new tests; the existing gate proves
  the fix.

### Manual Testing Steps:

1. Confirm CI's `rls` job log shows the CLI version `2.98.2`.
2. Confirm the `rls` job is green and no `permission denied for table
tournaments` appears in any suite's `beforeAll`.

## Migration Notes

No schema migration; no seed change.

## References

- Frame brief (with correction note): `context/changes/ci-pin-supabase-cli/frame.md`
- Change notes: `context/changes/ci-pin-supabase-cli/change.md`
- CI gate: `.github/workflows/ci.yml:86-122`
- CLI signing keys: `supabase/config.toml:158-162`
- Test plan: `context/foundation/test-plan.md:250` (§6.6), Risk #6 (§3)
- Reverted seed experiment: commit `4247271`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Pin the CLI to 2.98.2, revert the seed, document

#### Automated

- [x] 1.1 Seed revert clean: `git diff --stat 4247271^ -- supabase/seed.sql.template` is empty — 121b212
- [x] 1.2 Workflow valid YAML; `npm run lint` passes — 121b212
- [x] 1.3 Live-DB RLS suites pass locally against pinned 2.98.2: `npm test -- rls` → 57/57 — 121b212
- [x] 1.4 The PR's `rls` CI job passes with CLI 2.98.2 — 121b212

#### Manual

- [x] 1.5 Confirm on the PR that `rls` installed `2.98.2`, went green, and the `permission denied` error is gone from all suites — 121b212
