# Rebalance Per-Match Scoring to 5/3/2/0 — Plan Brief

> Full plan: `context/changes/scoring-points-rebalance/plan.md`

## What & Why

Widen the FR-018 scoring spread from `3/2/1/0` to `5/3/2/0` so nailing the exact score is rewarded more relative to getting only the goal-difference or the outcome right. Same tiers, same branch order — just bigger constants.

## Starting Point

Scoring is computed read-time in SQL (never TypeScript): `public.score_prediction` + the `prediction_scores` and `leaderboard` views, all in `supabase/migrations/20260605052647_results_scoring_leaderboard.sql`. The leaderboard's exact-score tie-break currently hardcodes `count(*) filter (where s.points = 3)`.

## Desired End State

`score_prediction` returns 5/3/2/0; the leaderboard tie-break counts 5-point (exact) rows; the live scoring grid proves the new values; PRD + roadmap describe 5/3/2/0 with no stale references. Scores recompute read-time — no backfill.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Point values | 5 / 3 / 2 / 0 | Rewards exact-score precision more than the compressed 3/2/1 ladder | Plan |
| Non-exact correct draw | 3 (difference tier) | Symmetric with a correct-margin win; no special-casing | Plan |
| Tier structure / branch order | Unchanged | Only constants change; keep same-difference-before-same-outcome | Plan |
| Doc scope | PRD + roadmap | Keep every reference consistent at 5/3/2/0 | Plan |
| Type regeneration | None | Function signature + view columns unchanged | Plan |

## Scope

**In scope:** `score_prediction` constants; `leaderboard` exact-score tie-break literal (`=3`→`=5`); scoring grid test; PRD FR-018/FR-020 + success metric; roadmap Q-01 note.

**Out of scope:** tier-structure changes, draw special-casing, configurable scoring, banker/per-goal/surprise schemes, type regen, data backfill, leaderboard ordering beyond the tie-break literal.

## Architecture / Approach

One additive, forward-only migration `create or replace`s the function (new constants + comment) and the `leaderboard` view (`=5` tie-break). The live scoring grid is updated in the same phase so it self-verifies. Docs follow in a code-free phase.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Data + tests | Migration (function + view) + updated scoring grid | Forgetting the `leaderboard` `=3`→`=5` tie-break literal |
| 2. Docs | PRD + roadmap aligned to 5/3/2/0 | Missing a stale "3-point" reference |

**Prerequisites:** local Supabase stack for the live scoring test; prod `supabase db push` before the Worker deploys.
**Estimated effort:** ~1 short session, 2 phases.

## Open Risks & Assumptions

- Deploy-ordering gate (migration before Worker), same as S-09 — low blast radius since no results exist pre-tournament.
- Assumes no other code/docs hardcode the old point values beyond those mapped (guarded by the Phase 2 `rg` check).

## Success Criteria (Summary)

- `npm run db:reset && npm test -- results-scoring` green at 5/3/2/0 (incl. non-exact draws = 3).
- `npm run lint && npm run build && npm run check:wrangler` clean.
- No stale `3/2/1` / "3-point" references remain in PRD or roadmap.
