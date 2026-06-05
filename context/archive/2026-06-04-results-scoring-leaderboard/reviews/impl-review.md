<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Results, Scoring & Leaderboard (S-04)

- **Plan**: context/changes/results-scoring-leaderboard/plan.md
- **Scope**: All 4 phases
- **Date**: 2026-06-05
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

## Success Criteria (re-run at HEAD 1b5d829)

- `npm run lint` — PASS (0 errors; 13 pre-existing `no-console` warnings)
- `npm test` (with Supabase env) — PASS (10 files, 84 tests)
- `npm run build` — PASS (server built)
- `npm run db:reset` / `npm run db:types` — PASS (applied during implementation; types regenerated with the new objects)

## Findings

### F1 — score_prediction() omits `set search_path = ''`

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality / Pattern Consistency
- **Location**: supabase/migrations/20260605052647_results_scoring_leaderboard.sql (score_prediction definition)
- **Detail**: The SECURITY DEFINER helpers (is_admin, match_is_kicked_off) lock search_path; score_prediction does not. This is consistent with the repo's other non-definer function, public.set_updated_at(), which also omits it, and the plan explicitly justified the omission ("no table access → no security context needed"). The function is pure arithmetic (sign() resolves from pg_catalog regardless of search_path) and is not SECURITY DEFINER, so risk is negligible. Defensible as-is.
- **Fix**: (optional) add `set search_path = ''` to score_prediction for uniformity with the definer helpers.
- **Decision**: SKIPPED — defensible as-is (pure non-definer fn, consistent with set_updated_at); not worth a new migration.

### F2 — Leaderboard order relies on the view-internal ORDER BY

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: src/pages/leaderboard/index.astro:24-26
- **Detail**: The page selects from `leaderboard` with no explicit `.order()`, trusting the view's `ORDER BY total_points desc, exact_scores desc, lower(display_name)`. Intentional (the plan calls it out) and works today (proven by the passing tie-break RLS test). Mildly fragile only if a future change adds pagination/limit or swaps the read path. Fine at MVP scale.
- **Fix**: (optional / defer) none needed now; revisit if pagination lands.
- **Decision**: SKIPPED — intended and test-proven; fine at MVP scale. Revisit if pagination is added.

### F3 — Past-match badge text changed from "Locked" to status label

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/components/admin/MatchList.tsx:46-48
- **Detail**: Past matches now show "Result entered" / "Awaiting result" instead of the old "Locked" text. Not in the literal plan, but squarely within its stated intent ("replace the bare 'Locked' label with a … form"). A benign UX improvement, not drift.
- **Fix**: none — accept as intended.
- **Decision**: ACCEPTED — benign UX improvement within plan intent.
