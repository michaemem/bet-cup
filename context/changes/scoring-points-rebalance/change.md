---
change_id: scoring-points-rebalance
title: Rebalance per-match scoring to 5/3/2/0 (wider exact-score reward)
status: implementing
created: 2026-06-09
updated: 2026-06-09
archived_at: null
---

## Notes

Widen the FR-018 scoring spread from 3/2/1/0 to 5/3/2/0 to reward exact-score precision more. Tiers and branch order are unchanged (exact / same goal-difference / same outcome / wrong); a correctly-predicted non-exact draw stays in the difference tier (3 pts), symmetric with correct-margin wins.

Scoring lives in SQL, not TypeScript:
- `public.score_prediction(...)` in `supabase/migrations/20260605052647_results_scoring_leaderboard.sql:77-91` — change constants 3→5, 2→3, 1→2 (and its comment) via a new `create or replace function` migration.
- `public.leaderboard` view, same migration `:128` — the exact-score tie-break hardcodes `count(*) filter (where s.points = 3)`; must become `= 5` or the precision tie-break silently breaks.
- Tests: `src/db/results-scoring.rls.test.ts` SCORING_GRID expected values + header comment.
- Docs: PRD FR-018 / FR-020 / success-metric line (`context/foundation/prd.md`).

Operational: new migration must be applied to prod before the Worker deploys (same gate as admin-reset-participant-password). Timing is ideal — tournament starts 2026-06-11, no results entered yet, so no participant's existing points change; scores recompute read-time from the view.
