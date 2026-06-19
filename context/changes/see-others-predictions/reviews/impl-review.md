<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: See Others' Predictions (per-match reveal)

- **Plan**: context/changes/see-others-predictions/plan.md
- **Scope**: All 3 phases
- **Date**: 2026-06-18
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 3 observations

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | PASS    |
| Scope Discipline    | PASS    |
| Safety & Quality    | PASS    |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | PASS    |

## Grounding

Changed-file set matches the plan exactly: all 7 planned source files present (`src/lib/match-predictions.ts` + `.test.ts`, `src/components/ui/dialog.tsx`, `src/components/predictions/MatchPredictionsDialog.tsx`, `src/components/predictions/PredictionList.tsx`, `src/pages/predictions/index.astro`, `src/db/match-predictions.rls.test.ts`). Extras limited to the expected `package.json`/`package-lock.json` `radix-ui ^1.4.3 → ^1.6.0` bump from `npx shadcn add dialog` (the canonical benign support-file case in `lessons.md`) and the change-tracking files (`change.md`, `plan.md`). No planned file missing.

Commits: `6ed3345` (p1 data layer), `e78e581` (p2 dialog UI), `cba65e1` (p3 RLS test), `8320e7a` (epilogue).

## Success criteria

- **Automated**: `npm run lint` (0 errors, 20 pre-existing no-console warnings), `npm run test` (86 passed | 76 skipped — the new RLS suite self-skips without DB env), `npm run build` (clean). RLS suite passed against a live local Supabase stack: `npm test -- match-predictions.rls` → 3/3 (reveal, blindness, leaderboard ordering).
- **Manual**: 1.4, 2.4–2.7, 3.4 all confirmed by the user and SHA-stamped in Progress.

## Findings

### F1 — Viewer's own kicked-off predictions read twice

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: src/pages/predictions/index.astro:44-48 + src/lib/match-predictions.ts loader reads
- **Detail**: The page's own-predictions read (for `LockedScore`/form seeding) and the loader's all-participants read overlap for the viewer's own kicked-off rows. Harmless duplication serving two different surfaces; negligible at friend-pool scale.
- **Fix**: None needed. Leave as-is.
- **Decision**: SKIPPED (no action)

### F2 — Roster null-id rows dropped vs leaderboard's coerce-to-""

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/lib/match-predictions.ts:165-173
- **Detail**: `leaderboard/index.astro:32-37` coerces a null `participant_id` to `""` and keeps the row; the loader instead skips null-id roster rows and coalesces `display_name ?? "—"`. Dropping a null-id entry is arguably more correct than synthesizing a `""` roster row.
- **Fix**: None needed — intentional, defensible divergence.
- **Decision**: SKIPPED (no action)

### F3 — Additive deltas: empty-map test + unused showCloseButton

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/lib/match-predictions.test.ts (extra empty-map case); src/components/ui/dialog.tsx (generated `DialogFooter` `showCloseButton` prop)
- **Detail**: One additive unit test beyond the planned (a)–(f) cases, and an unused `showCloseButton` prop on the shadcn-generated `DialogFooter`. Both benign; the latter is generated code AGENTS.md says not to hand-edit.
- **Fix**: None needed.
- **Decision**: SKIPPED (no action)
