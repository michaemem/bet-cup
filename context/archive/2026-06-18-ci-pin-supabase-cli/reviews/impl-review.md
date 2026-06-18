<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: CI rls Gate Fix — Pin Supabase CLI to 2.98.2

- **Plan**: context/changes/ci-pin-supabase-cli/plan.md
- **Scope**: Phase 1 of 1
- **Date**: 2026-06-18
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 1 observation

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | PASS    |
| Scope Discipline    | PASS    |
| Safety & Quality    | PASS    |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | PASS    |

## Evidence

- Net code diff over the change's commits (`4d3c9de..HEAD`) is exactly the CI pin
  (`.github/workflows/ci.yml`: `version: latest` → `2.98.2` + rationale comment).
- `supabase/seed.sql.template` is byte-identical to base (the `4247271`
  durable-seed experiment is fully reverted; `git diff 4d3c9de..HEAD` on it is
  empty).
- `npm run lint` → 0 errors. `npm test -- rls` → 57/57 under pinned 2.98.2.
- PR #24 `rls` CI job green; log confirms installed CLI `2.98.2`, 0
  `permission denied for table tournaments`.
- Root cause corrected from the frame (ES256 JWT signing-key default in
  v2.107.0, not admin-seed promotion); correction recorded in `frame.md` and
  test-plan §6.6.

## Findings

### F1 — Pin is version debt with an external lift condition

- **Severity**: 🔎 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; nothing to fix now
- **Dimension**: Safety & Quality
- **Location**: .github/workflows/ci.yml:99-106
- **Detail**: Pinning to 2.98.2 freezes the gate on an older CLI. The lift
  condition (RLS suites support ES256 asymmetric signing keys) is documented in
  the workflow comment and test-plan §6.6, but there is no tracked reminder, so
  the pin can silently rot.
- **Fix**: Capture the /10x-lesson (planned next) and/or open a follow-up to
  migrate the RLS harness to ES256 and unpin. No code change now.
- **Decision**: ACCEPTED (tracked via lesson + test-plan lift condition)
