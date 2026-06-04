<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: S-03 Prediction-with-Blindness

- **Plan**: context/changes/prediction-with-blindness/plan.md
- **Scope**: All 4 phases (full plan)
- **Date**: 2026-06-04
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 3 observations

## Automated success criteria (re-run locally, Node 22)

| Check | Result |
|-------|--------|
| `npm run lint` | ✅ 0 errors (11 pre-existing `no-console` warnings) |
| `npm test` | ✅ 43 passed, 17 skipped (RLS suites self-skip without DB env, as designed) |
| `npm run build` | ✅ server build complete |
| DB types | ✅ `predictions` Row/Insert/Update + `match_is_kicked_off` present in `src/db/database.types.ts` |
| CI `rls` job | ✅ recorded green (commit 16b116f); not re-run locally (needs Docker/Supabase) |

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Summary

Clean, high-quality slice. The integrity-load-bearing parts are correct:

- `predictions_select` is owner-OR-post-kickoff with **no `is_admin()` branch** (migration L78-81); the live RLS test proves admin + cross-participant blindness pre-kickoff and the reveal post-kickoff.
- The kickoff write-lock is enforced on **both** INSERT and UPDATE policies (L83-92), closing the upsert-after-kickoff hole flagged as critical in the plan.
- No predictions path imports the service-role client — everything rides the session SSR client, so RLS owns the blindness invariant.
- All six "What We're NOT Doing" guardrails respected. The only "extra" is a second seeded past match in the RLS test to exercise the INSERT-denied path — a justified test improvement.

## Findings

### F1 — App pre-check discards the match read error

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Reliability)
- **Location**: src/actions/index.ts:297-304
- **Detail**: The kickoff pre-check destructures only `{ data: match }` and drops `error`. A transient Supabase read failure surfaces as a misleading "Match not found." (NOT_FOUND) rather than an internal error. Intentionally consistent with the existing `matches.update` convention, and the RLS zero-row guard remains the real backstop — not a correctness bug, just a slightly misleading error on DB failure.
- **Fix**: Capture the error and route it through `internalError()` before the `!match` check, if you want failure/absence distinguished.
- **Decision**: FIXED — captured `matchError` and `throw internalError(matchError)` before the `!match` check (src/actions/index.ts).

### F2 — match_is_kicked_off() relies on the default PUBLIC execute grant

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Security)
- **Location**: supabase/migrations/20260604184657_predictions_with_blindness.sql:60-71
- **Detail**: The SECURITY DEFINER helper is created without an explicit revoke/grant, so it carries Postgres' default EXECUTE-to-PUBLIC. It only returns a boolean about kickoff status (no row data, no prediction-content leak), and `is_admin()` in the same schema follows the same default-grant style — a consistency note, not a hole.
- **Fix**: Optionally `revoke execute ... from public; grant execute ... to authenticated;` to match least-privilege intent.
- **Decision**: SKIPPED — boolean-only return (no data leak), matches the existing `is_admin()` helper convention; not worth a new migration.

### F3 — `timeZone` not passed to the island (literal plan deviation)

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/pages/predictions/index.astro:62,85
- **Detail**: Phase 3 said "Pass rows + timeZone to the island." The page instead pre-formats `kickoffLocal` via `formatInZone` server-side and the island never needs the zone. Intent (correct local kickoff display) is fully met; the prop is genuinely unnecessary. No action needed — noted only for plan-vs-code completeness.
- **Fix**: None needed.
- **Decision**: SKIPPED — accepted as an intentional, cleaner deviation (kickoff is pre-formatted server-side via `formatInZone`; the island has no use for the zone).
