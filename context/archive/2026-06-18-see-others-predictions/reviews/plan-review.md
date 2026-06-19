<!-- PLAN-REVIEW-REPORT -->

# Plan Review: See Others' Predictions (per-match reveal)

- **Plan**: context/changes/see-others-predictions/plan.md
- **Mode**: Deep
- **Date**: 2026-06-18
- **Verdict**: SOUND
- **Findings**: 0 critical, 1 warning, 2 observations

## Verdicts

| Dimension             | Verdict |
| --------------------- | ------- |
| End-State Alignment   | PASS    |
| Lean Execution        | PASS    |
| Architectural Fitness | PASS    |
| Blind Spots           | PASS    |
| Plan Completeness     | WARNING |

## Grounding

5/5 paths ✓ (`history.ts`, `predictions/index.astro`, `PredictionList.tsx`, leaderboard view migration, blindness migration; `dialog.tsx` correctly absent, `alert-dialog`/`popover` present), 6/6 symbols ✓ (`leaderboard` columns + `ORDER BY`, `prediction_scores` `predictor_id/match_id/points`, `match_results` columns, owner-OR-kicked-off `predictions_select`), brief↔plan ✓, blast-radius ✓ (`PredictionMatchRow` consumed only by `index.astro` + `PredictionList.tsx`).

## Findings

### F1 — Loader/builder data-shape specifics under-specified

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §1 — `loadMatchPredictions` / `buildMatchPredictionRows` Contract
- **Detail**: Two implementation realities the Contract glosses, both with a concrete precedent. (a) **Nullable view columns**: generated Supabase types make `leaderboard.participant_id`/`display_name` and `prediction_scores.predictor_id`/`match_id`/`points` return as `T | null` — already handled defensively at `leaderboard/index.astro:32-37` and `history.ts:157-162`. The roster/score types are non-null, so the loader must filter/coerce or it won't type-check, and the Contract doesn't say how. (b) **Score lookup key**: `history.ts` keyed points by `match_id` alone (single participant); this builder is per-(match, participant), so scores must be keyed by the COMPOSITE `(match_id, predictor_id)` — "points: from scores when present" leaves that implicit, and a match_id-only key would mis-assign points.
- **Fix**: In the Phase 1 Contract, state (a) the loader drops roster rows with null `participant_id`, coalesces `display_name`, and skips score rows with null `predictor_id`/`match_id`/`points` (mirror `history.ts:157-162`); (b) the builder indexes scores by the `(match_id, predictor_id)` composite key.
- **Decision**: FIXED — applied to Phase 1 §1 Contract (builder composite key + loader null-coercion)

### F2 — Loader drops the "friendly mirror" query filter

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Lean Execution / Architectural Fitness
- **Location**: Phase 1 §1 — `loadMatchPredictions` reads
- **Detail**: `history.ts` deliberately filters predictions/scores by predictor as a defense-in-depth mirror of RLS (its comment: "filtering ... is a friendly mirror of that boundary, never the guard"). The new loader reads ALL predictions/results/scores unfiltered and relies on the pure builder to discard non-kicked-off matches. Functionally safe — RLS is the real guard and the builder only emits kicked-off matches — but it diverges from the established mirror philosophy and ships rows for unresolved matches over the wire.
- **Fix**: Optionally add `.in("match_id", kickedOffMatchIds)` to the predictions/results/scores reads as the explicit mirror (the empty-list short-circuit already covers the zero case). Keeps the loader consistent with `history.ts` and trims payload.
- **Decision**: FIXED — Phase 1 §1 loader now scopes predictions/results/scores reads with `.in("match_id", kickedOffMatchIds)` as a friendly mirror

### F3 — isPast vs match_is_kicked_off clock-skew boundary unmentioned

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 §4 — `kickedOffMatchIds` derivation
- **Detail**: `kickedOffMatchIds` is derived from `isPast` (app-server `Date.now()` in the .astro frontmatter), but the actual reveal is gated by `match_is_kicked_off` (DB `now()`). In the few seconds around kickoff, skew could make a row show the button (isPast true) while RLS hasn't yet revealed others' rows → the dialog briefly shows only the viewer with everyone else as "—". It degrades gracefully and is the SAME boundary the existing `LockedScore`/`PredictionForm` split already uses, so there's no regression.
- **Fix**: Add a sentence to "Performance Considerations" or "What We're NOT Doing" noting the transient near-kickoff skew is accepted and self-heals on next render (documentation only).
- **Decision**: FIXED — documented under "Performance Considerations" as an accepted clock-skew boundary

## Note

Phase 3 (RLS test) was considered for a redundancy flag — blindness is already exhaustively proven by `predictions.rls.test.ts`, and the case-(c) "blindness smoke" duplicates it. Not flagged: the test's unique value is asserting leaderboard ordering survives PostgREST's implicit `ORDER BY` through `loadMatchPredictions`, which a pure unit test structurally cannot verify.
