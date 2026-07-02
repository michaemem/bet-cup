---
change_id: match-predictions-row-cap
title: Fix others' predictions points showing 0 due to Supabase 1000-row query cap
status: archived
created: 2026-07-02
updated: 2026-07-02
archived_at: 2026-07-02T09:52:47Z
---

## Notes

Symptom: On the predictions page, "See others' predictions" renders other
participants' predictions correctly, but their points display as `0` even
though they earned points. The leaderboard shows correct totals. This worked
early in the tournament and degraded "recently".

Root cause: `loadMatchPredictions()` in `src/lib/match-predictions.ts` runs
unbounded reads (`predictions`, `prediction_scores`) scoped to ALL kicked-off
matches via `.in("match_id", kickedOffMatchIds)` with no `.range()`/pagination.
Supabase's default `db-max-rows` cap (1,000) silently truncates these queries
once `participants x kicked-off matches` exceeds ~1,000 rows. When a
`(match_id, predictor_id)` score row is dropped, `buildMatchPredictionRows`
falls through to `points = null`, and the dialog renders `participant.points ??
0` as `0` — indistinguishable from a legitimate scored 0.

Why the leaderboard stays correct: it reads the pre-aggregated `leaderboard` SQL
view (`SUM(prediction_scores.points)` grouped per participant) → one row per
participant, far below the 1,000-row cap. The truncation only bites the raw
per-match/per-participant reads on the predictions page.

Fix direction (to be planned):

- Primary: paginate the reads with `.range()` until exhausted, OR scope reads to
  only the match(es) being viewed (per-match on-demand load) so payloads don't
  grow unbounded.
- Secondary: stop coercing `null` points to `0` in the UI so genuinely-missing
  data can't masquerade as a scored 0.
- Raising `db-max-rows` in project settings is only a band-aid.

Relevant files:

- `src/lib/match-predictions.ts` (`loadMatchPredictions`, `buildMatchPredictionRows`)
- `src/components/predictions/MatchPredictionsDialog.tsx` (`points ?? 0`)
- `src/pages/predictions/index.astro` (page loader / `kickedOffMatchIds`)
- `src/db/match-predictions.rls.test.ts` (existing coverage — passes because its
  data volume is below the cap)
