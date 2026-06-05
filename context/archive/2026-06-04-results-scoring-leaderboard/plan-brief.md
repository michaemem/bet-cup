# Results, Scoring & Leaderboard (S-04, north star) — Plan Brief

> Full plan: `context/changes/results-scoring-leaderboard/plan.md`
> Research: `context/changes/results-scoring-leaderboard/research.md`

## What & Why

Complete BetCup's north-star path: the admin enters/corrects a match result after kickoff, every prediction is scored 3/2/1/0 (FR-018), and all participants are ranked on a leaderboard (FR-020). This is the slice that proves the product hypothesis — predictions, blindness, results, scoring, and standings all working end-to-end.

## Starting Point

S-02 shipped `matches` (no result columns) and S-03 shipped `predictions` with the blindness/visibility RLS. FR-016 (post-kickoff prediction visibility) is already live and untouched here. There is no result storage, no scoring, and no leaderboard yet. The existing `matches_update` policy blocks all post-kickoff writes, which forces results into their own table.

## Desired End State

On `/admin`, kickoff-passed matches show an inline score form (enter and later correct). Every authenticated user sees `/leaderboard` ranking all participants by total points, tie-broken by exact-score count then alphabetically, updating on next load after a result is entered or corrected. Pre-kickoff matches stay blind.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Result storage | New `match_results` table | Keeps the FR-008 fixture lock on `matches` untouched; clean post-kickoff admin RLS | Plan |
| Scoring | `score_prediction()` SQL fn + `prediction_scores` view (read-time) | Always correct; FR-010 recompute-on-correction is free; nothing to invalidate | Research/Plan |
| Leaderboard | `leaderboard` SQL view (`security_invoker=true`) | Tie-break atomic in SQL; blindness preserved via the post-kickoff-result invariant | Plan |
| Admin result UI | Extend `/admin` `MatchList` with inline form | Least new surface; admin already lists matches with `isPast` | Plan |
| Result rules | Post-kickoff-only, defense-in-depth, editable anytime | Mirrors the predictions write pattern; can't score an unplayed match | Plan |
| Leaderboard scope | All participants, 0 for non-predictors | Matches FR-019/FR-020 verbatim | Plan |
| Access | `/leaderboard` for all authed, dashboard link | Participant-facing per FR-020 | Plan |
| Testing | FR-018 grid + tie-break + result RLS in CI `rls` job | Pins the two PRD correctness guardrails and the new policy | Plan |

## Scope

**In scope:** `match_results` table + RLS; `score_prediction` function; `prediction_scores` + `leaderboard` views; `results.upsert` Action; admin inline result form; `/leaderboard` page; DB tests.

**Out of scope:** participant history (S-05), participant delete (S-06), "who predicted" indicator, real-time updates, result deletion, any change to blindness/fixture policies, new service-role usage.

## Architecture / Approach

DB-first. Results live in `match_results` (admin-write, post-kickoff only). Scoring is a pure SQL function consumed by `prediction_scores`; the `leaderboard` view aggregates that plus `profiles_public` with the tie-break `ORDER BY`. Because results only exist post-kickoff and post-kickoff predictions are world-visible, an invoker-rights leaderboard view is both complete and leak-free. The admin writes via an Astro Action mirroring `predictions.upsert` (admin + post-kickoff guard); the leaderboard page just selects the view.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Data model & scoring | Migration (table, RLS, fn, views, grants) + DB tests | FR-018 ordering / leaderboard view RLS correctness |
| 2. Result-entry backend | `results.upsert` Action + zod schema | Post-kickoff guard / NOT_FOUND-vs-lock handling |
| 3. Admin result UI | Inline result form on `/admin` | Mixing fixture-edit and result-entry states cleanly |
| 4. Leaderboard page | `/leaderboard` + dashboard link | Empty/tie display correctness |

**Prerequisites:** F-01, S-02, S-03 (all done); local Supabase for the DB tests.
**Estimated effort:** ~2–3 sessions across 4 phases.

## Open Risks & Assumptions

- Assumes `now()` evaluates per-row at query time so the post-kickoff result/visibility boundary is consistent (already relied on by S-03).
- Assumes the `leaderboard` view's invoker-rights model + the post-kickoff-result invariant fully covers completeness — the FR-019 completeness DB test guards this.
- The FR-018 grid runs as a DB test (scoring is SQL), not a pure unit test — acceptable and stronger, runs in the CI `rls` job.

## Success Criteria (Summary)

- Admin enters/corrects a result on a past match; the leaderboard reflects correct, recomputed totals on next load.
- Every participant is ranked (0 for non-predictors); ties broken by exact-score count then alphabetically.
- Blindness is preserved: pre-kickoff predictions stay hidden; FR-018 scoring is exhaustively correct.
