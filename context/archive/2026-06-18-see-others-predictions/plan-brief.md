# See Others' Predictions (per-match reveal) — Plan Brief

> Full plan: `context/changes/see-others-predictions/plan.md`

## What & Why

Add a per-match "See others' predictions" pop-up on `/predictions`. Once a match has kicked off, a participant can see every other participant's prediction for it (and, after a result, the points), in leaderboard order. It extends S-05 (which gave per-_participant_ history) along the per-_match_ axis, while preserving the FR-015 blindness rule: never reveal a prediction before kickoff.

## Starting Point

`/predictions/index.astro` already server-renders the match list and loads only the caller's own predictions, passing rows into the `PredictionList` island (kicked-off rows show a read-only "Locked" score). The `leaderboard`, `prediction_scores`, and `match_results` views/tables and the owner-OR-post-kickoff `predictions_select` RLS policy already exist from S-04/S-03.

## Desired End State

Every kicked-off match row on `/predictions` has a button that opens a dialog listing all participants in leaderboard standings order with their prediction (or "—" if they didn't predict), the viewer's own row marked "you", and — when a result exists — the result plus a points column (non-predictors show 0). Future matches show no button; pre-kickoff picks are never fetched.

## Key Decisions Made

| Decision         | Choice                                         | Why (1 sentence)                                                   | Source |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------ | ------ |
| Scope of reveal  | Kicked-off matches only (locked + past)        | Matches the existing blindness RLS boundary exactly                | Change |
| Button placement | Per kicked-off row on `/predictions`           | Where the participant already sees the locked match                | Change |
| List ordering    | Global leaderboard standings                   | "Same order as the leaderboard"                                    | Change |
| Include self     | Yes, own row highlighted                       | Full picture, with "you" marker                                    | Change |
| Non-predictors   | Listed with "—"; points 0 when a result exists | Mirrors leaderboard/history semantics (FR-019)                     | Change |
| Data loading     | Eager server-side (no new action/endpoint)     | Tiny dataset; keeps blindness server-enforced; matches SSR pattern | Plan   |
| Modal primitive  | Add shadcn `dialog`                            | Correct semantics for a list pop-up; AGENTS-compliant              | Plan   |
| Test depth       | Unit (pure builder) + new RLS integration test | Pin merge logic cheaply + belt-and-suspenders on the invariant     | Plan   |

## Scope

**In scope:** new `src/lib/match-predictions.ts` (pure builder + RLS loader) + unit test; shadcn `dialog`; `MatchPredictionsDialog.tsx`; wiring in `PredictionList.tsx` + `/predictions/index.astro`; `src/db/match-predictions.rls.test.ts`.

**Out of scope:** any migration/RLS/schema change; new actions/endpoints; leaderboard/dashboard/history changes; scoring changes; real-time updates; per-match ordering.

## Architecture / Approach

`/predictions/index.astro` computes the kicked-off match ids and calls `loadMatchPredictions` (reads `leaderboard` for the ordered roster + names, `predictions`, `match_results`, `prediction_scores` — all under the caller's RLS). A pure `buildMatchPredictionRows` merges these into a per-match ordered participant list + result, attached to each `PredictionMatchRow`. The `PredictionList` island renders a `MatchPredictionsDialog` trigger on kicked-off rows, fed already-loaded data — no client fetching.

## Phases at a Glance

| Phase         | What it delivers                                              | Key risk                               |
| ------------- | ------------------------------------------------------------- | -------------------------------------- |
| 1. Data layer | `match-predictions.ts` (pure builder + loader) + unit tests   | Ordering / points-sourcing correctness |
| 2. UI         | shadcn dialog + `MatchPredictionsDialog` + page/island wiring | Dialog UX + mobile layout              |
| 3. RLS test   | `match-predictions.rls.test.ts` (live-DB)                     | Requires local Supabase stack to run   |

**Prerequisites:** S-04 shipped (leaderboard + scoring views exist); local Supabase stack for the Phase 3 test.
**Estimated effort:** ~1–2 sessions across 3 phases.

## Open Risks & Assumptions

- Assumes the `leaderboard` view's implicit ORDER BY is relied upon for roster order (already the case in `leaderboard/index.astro`).
- No new DB surface bypasses RLS, so blindness is unchanged; the new RLS test is confirmatory.
- Eager load adds 4 small reads per page render — negligible at friend-pool scale.

## Success Criteria (Summary)

- A participant can open any kicked-off match and see everyone's predictions in leaderboard order; results/points appear once entered; non-predictors show "—"/0.
- No pre-kickoff prediction is ever revealed (RLS test green).
- `npm run lint`, `npm run test`, `npm run build` all pass.
