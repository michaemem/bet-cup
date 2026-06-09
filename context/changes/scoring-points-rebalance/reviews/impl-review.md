<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Rebalance Per-Match Scoring to 5/3/2/0

- **Plan**: context/changes/scoring-points-rebalance/plan.md
- **Scope**: Phases 1–2 of 2
- **Date**: 2026-06-09
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Success Criteria (verified live)

- `npm run db:reset` — migration `20260609084451_rebalance_scoring_points.sql` applied cleanly.
- `npm test -- results-scoring` — 29 passed (grid + leaderboard fixtures at 5/3/2/0).
- `npm run lint` — 0 errors (pre-existing `no-console` warnings only).
- `npm run build` — server build complete.
- `npm run check:wrangler` — `nodejs_compat` present.
- DB spot-check: `score_prediction` 2-1↔2-1=5, 2-2↔1-1=3, 3-1↔2-0=3, 3-0↔2-1=2, 2-0↔0-2=0; `leaderboard` tie-break filter = `points = 5`.

## Findings

### F1 — Test changes exceeded the literal "update SCORING_GRID"

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; informational
- **Dimension**: Plan Adherence
- **Location**: src/db/results-scoring.rls.test.ts:228-353
- **Detail**: The leaderboard + recompute fixtures also encoded old totals and were recomputed (Alpha/Bravo 7, Charlie 6, echo exact 5). Necessary and correct; the plan slightly under-specified the test surface.
- **Decision**: ACCEPTED

### F2 — Doc edits reached beyond the literally-named files

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; informational
- **Dimension**: Scope Discipline
- **Location**: context/foundation/prd.md:157, context/foundation/test-plan.md:77
- **Detail**: Beyond FR-018/FR-020 + roadmap Q-01, the PRD Non-Goals line and test-plan scenario #2 were updated for consistency (matches the "all references" choice). shape-notes.md left at 3/2/1/0 by design as the historical discovery record. Aligns with lessons.md "unplanned-but-benign" rule.
- **Decision**: ACCEPTED

### F3 — Prod deploy-ordering gate

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🔎 MEDIUM — real gate; act at deploy time
- **Dimension**: Safety & Quality
- **Location**: supabase/migrations/20260609084451_rebalance_scoring_points.sql
- **Detail**: Migration is not auto-applied to prod. Apply via `supabase db push` before the Worker serving the new leaderboard deploys. Blast radius minimal (no results entered pre-tournament), but keep the order.
- **Decision**: ACCEPTED
