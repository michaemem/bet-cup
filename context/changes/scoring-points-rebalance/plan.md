# Rebalance Per-Match Scoring to 5/3/2/0 Implementation Plan

## Overview

Widen the FR-018 per-match scoring spread from `3 / 2 / 1 / 0` to `5 / 3 / 2 / 0` so an exact-score prediction is rewarded more relative to a merely-correct-difference or correct-outcome call. The tier structure and the load-bearing branch order are unchanged: exact → same goal-difference → same outcome → wrong. A correctly-predicted non-exact draw stays in the difference tier and is therefore worth **3** (symmetric with a correct-margin win); the "outcome-only" tier (2) remains structurally unreachable for draws.

## Current State Analysis

Scoring is computed in SQL, read-time — never in TypeScript (`src/lib/history.ts:11-14`). The whole FR-018/FR-020 rule lives in one migration, `supabase/migrations/20260605052647_results_scoring_leaderboard.sql`:

- **`public.score_prediction(p_home, p_away, r_home, r_away)`** (`:77-91`) — pure `immutable` `language sql` function. Body: `case when exact then 3 when same-difference then 2 when same-outcome then 1 else 0 end`. Branch order is load-bearing (same-difference is tested before same-outcome because it subsumes it). Has a `comment on function` describing "3 exact / 2 same goal-difference / 1 same outcome / 0 wrong".
- **`public.prediction_scores`** view (`:99-111`) — calls `score_prediction(...)` per prediction joined to a result. No literal point values; needs no change.
- **`public.leaderboard`** view (`:121-132`) — `coalesce(sum(s.points),0) as total_points`, `count(*) filter (where s.points = 3) as exact_scores`, ordered `total_points desc, exact_scores desc, lower(display_name) asc`. The `= 3` literal is the FR-020 exact-score tie-break and **must move to `= 5`**, else the precision tie-break silently rewards the wrong tier.

Tests + docs encoding the old numbers:
- `src/db/results-scoring.rls.test.ts:65-96` — `SCORING_GRID` (20 cases) with `expected: 3 | 2 | 1 | 0`, plus the header comment ("exact (3)", "same goal-difference (2)", "same outcome (1)").
- `context/foundation/prd.md` — FR-018 (`:115`), FR-020 + its "3-point" decision note (`:117-118`), the success-metric line (`:132`), and the SUCCESS narrative (`:136-140`).
- `context/foundation/roadmap.md` — Q-01 tie-break note references "3-point predictions".

### Key Discoveries:

- The function signature and view column shapes do NOT change, so `src/db/database.types.ts` does **not** need regenerating.
- Scores are derived read-time from a plain (non-materialized) view; replacing the `immutable` function recomputes everything on next read with no data backfill.
- Timing is ideal: the tournament starts 2026-06-11 and no `match_results` exist yet, so no participant's existing points change.
- The only test that exercises the values is the live-DB `results-scoring.rls.test.ts` (runs in CI's `rls` job and locally with `SUPABASE_*` set); there is no always-run unit test for the scoring math.

## Desired End State

- `score_prediction` returns `5 / 3 / 2 / 0`; the `leaderboard` exact-score tie-break counts 5-point rows; `prediction_scores` unchanged.
- `npm run db:reset` applies cleanly; `npm test -- results-scoring` proves the new grid (exact 5, same-diff incl. non-exact draws 3, same-outcome 2, wrong 0).
- PRD and roadmap describe 5/3/2/0 consistently; no stale "3-point"/"3/2/1" references remain.
- Migration applied to prod before the Worker that relies on it deploys (same gate as `admin-reset-participant-password`).

### Verification

- `npm run db:reset && npm test -- results-scoring` (local stack) — grid green at the new values.
- `npm run lint && npm run build && npm run check:wrangler` — clean.
- `rg -n "3 / 2 / 1|3-point|3 exact"` across `context/foundation` and `src` returns nothing referring to the old scheme.

## What We're NOT Doing

- **No tier-structure change** — still exact / same-difference / same-outcome / wrong, same branch order. Only the four constants and one tie-break literal change.
- **No special-casing of draws** — a non-exact correct draw stays in the difference tier (3); we are explicitly NOT pushing it down to the outcome tier (2).
- **No configurable scoring** — the rule stays hardcoded for v1 (PRD non-goal).
- **No banker/confidence pick, per-goal credit, or surprise weighting** — out of scope (possible future feature).
- **No type regeneration** — function signature and view columns are unchanged.
- **No backfill / data migration** — scores recompute read-time from the view.
- **No leaderboard ordering change** beyond the exact-score-count literal — `total_points desc, exact_scores desc, name asc` stays.

## Implementation Approach

One additive, forward-only migration that `create or replace`s both the function (new constants + updated comment) and the `leaderboard` view (tie-break `= 5`), mirroring the project's migration conventions. The live scoring grid is updated in the same phase so the phase self-verifies (the migration would otherwise turn the suite red). Docs follow in a second, code-free phase.

## Critical Implementation Details

- **The leaderboard tie-break literal is the silent landmine.** `count(*) filter (where s.points = 3)` must become `where s.points = 5` in the same migration. Changing only the function would leave the FR-020 "most exact scores" tie-break counting the new same-difference tier instead of exact scores.
- **Deploy ordering is a release gate.** Like S-09, CI does not auto-apply migrations to prod. Apply this migration to prod (`npx supabase db push`) before the Worker build that reads the new leaderboard goes live. Low blast radius here (no results entered yet), but keep the order.

## Phase 1: Data layer + tests — new scoring constants

### Overview

Add a migration that replaces `score_prediction` with the `5/3/2/0` constants and updates the `leaderboard` exact-score tie-break to `= 5`, and update the live scoring grid to the new expected values so the suite proves the change.

### Changes Required:

#### 1. Scoring + leaderboard migration

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_rebalance_scoring_points.sql` (new — generate the name via `npm run db:migration:new rebalance_scoring_points`)

**Intent**: Change the FR-018 point values to `5/3/2/0` and keep the FR-020 exact-score tie-break pointing at the exact tier.

**Contract**: `create or replace function public.score_prediction(int, int, int, int)` with identical signature/`immutable`/`language sql` and identical branch order, returning `5` (exact) / `3` (same goal-difference) / `2` (same outcome) / `0` (wrong); update its `comment on function` to read "5 exact / 3 same goal-difference / 2 same outcome / 0 wrong". Then `create or replace view public.leaderboard` identical to the current definition except `count(*) filter (where s.points = 5) as exact_scores`; keep `security_invoker = true` and the `order by total_points desc, exact_scores desc, lower(pr.display_name) asc`. Re-`grant select` only if the `create or replace view` drops grants (it should not for a replace; verify after `db:reset`).

#### 2. Live scoring grid

**File**: `src/db/results-scoring.rls.test.ts` (edit)

**Intent**: Assert the new point values, including the draw-in-difference-tier rule.

**Contract**: In `SCORING_GRID` (`:67-96`) update every `expected` to the new scheme (exact `3→5`; same-difference incl. the two draw cases `2→3`; same-outcome `1→2`; wrong stays `0`; upper-bound cases likewise). Update the section comments ("exact (5)", "same goal-difference (3)", "same outcome (2)"). Derive expected values from the FR-018 spec, not from the function body. Keep all 20 cases and their labels.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npm run db:reset` completes without error.
- Scoring grid passes at new values: `npm test -- results-scoring` (local stack, `SUPABASE_*` set).
- Lint/type-check clean: `npx astro sync && npm run lint`.
- Build passes: `npm run build`.
- `check:wrangler` passes: `npm run check:wrangler`.

#### Manual Verification:

- In Supabase Studio (or `psql`), `select public.score_prediction(2,2,1,1)` returns `3` (non-exact draw → difference tier) and `select public.score_prediction(2,1,2,1)` returns `5` (exact).
- The `leaderboard` view's `exact_scores` column counts only 5-point rows.

**Implementation Note**: After automated verification passes, pause for manual confirmation of the function values + leaderboard tie-break before starting Phase 2.

---

## Phase 2: Docs — align PRD + roadmap with 5/3/2/0

### Overview

Update every prose reference to the old scheme so the spec matches the shipped behavior.

### Changes Required:

#### 1. PRD scoring text

**File**: `context/foundation/prd.md` (edit)

**Intent**: State the new point values everywhere the old ones appear.

**Contract**: FR-018 (`:115`) — `3/2/1` → `5/3/2` with the same tier descriptions. FR-020 + its decision note (`:117-118`) — replace "exact-score (3-point) predictions" / "3-point predictions" with "exact-score (5-point) predictions". Success-metric line (`:132`) and the SUCCESS narrative (`:136-140`) — update any explicit point values; keep wording that's value-agnostic. Do not change the tier semantics or the tie-break rule, only the numbers.

#### 2. Roadmap tie-break note

**File**: `context/foundation/roadmap.md` (edit)

**Intent**: Keep the Q-01 tie-break description consistent.

**Contract**: In the Q-01 resolution note, change "3-point predictions" to "exact-score (5-point) predictions". Leave the historical decision/date/issue reference intact.

### Success Criteria:

#### Automated Verification:

- No stale references remain: `rg -n "3 / 2 / 1|3-point|3 exact|3/2/1"` over `context/foundation` and `src` returns nothing about the old scheme.
- Lint still passes (docs don't affect it, but run once): `npm run lint`.

#### Manual Verification:

- Read FR-018/FR-020 and the roadmap Q-01 note end-to-end — the scoring story is internally consistent at 5/3/2/0.

**Implementation Note**: After Phase 2, the change is ready for `/10x-impl-review`, then the prod migration + PR.

---

## Testing Strategy

### Unit Tests:

- None added — scoring is SQL-only; there is no always-run unit for the math.

### Integration Tests (live Supabase):

- `results-scoring.rls.test.ts` `SCORING_GRID`: exact = 5; same goal-difference (incl. non-exact draws) = 3; same outcome = 2; wrong = 0; upper-bound boundary cases at the new values.

### Manual Testing Steps:

1. `npm run db:reset`; `select public.score_prediction(2,1,2,1)` = 5, `(2,2,1,1)` = 3, `(3,0,2,1)` = 2, `(2,0,0,2)` = 0.
2. With a couple of seeded predictions + results, read `public.leaderboard` and confirm `exact_scores` counts only 5-point rows and ordering is unchanged.

## Performance Considerations

Negligible — `score_prediction` stays a pure `immutable` scalar; the views are unchanged in shape. No new indexes or queries.

## Migration Notes

- **Additive, forward-only.** `create or replace` of a function + view; no schema/column change, no data backfill (scores recompute read-time).
- **Deploy ordering is a release gate.** Per AGENTS.md, migrations are not auto-applied to prod. Apply with `npx supabase db push` (preview `--dry-run`; confirm `npx supabase migration list --linked`) BEFORE the Worker that serves the new leaderboard deploys. Blast radius is minimal pre-tournament (no results yet), but keep the order.
- **No new secret / no type regeneration.**

## References

- Change folder: `context/changes/scoring-points-rebalance/`
- Scoring SQL: `supabase/migrations/20260605052647_results_scoring_leaderboard.sql:77-135`
- Scoring grid test: `src/db/results-scoring.rls.test.ts:65-96`
- PRD: FR-018 (`context/foundation/prd.md:115`), FR-020 (`:117-118`)
- Roadmap Q-01 tie-break note: `context/foundation/roadmap.md`
- Read-time scoring rationale: `src/lib/history.ts:11-14`
- Deploy-gate precedent (S-09): `context/archive/2026-06-08-admin-reset-participant-password/plan.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Data layer + tests — new scoring constants

#### Automated

- [x] 1.1 Migration applies cleanly: `npm run db:reset` — ede801b
- [x] 1.2 Scoring grid passes at new values: `npm test -- results-scoring` — ede801b
- [x] 1.3 Lint/type-check clean: `npx astro sync && npm run lint` — ede801b
- [x] 1.4 Build passes: `npm run build` — ede801b
- [x] 1.5 `check:wrangler` passes: `npm run check:wrangler` — ede801b

#### Manual

- [x] 1.6 `score_prediction(2,2,1,1)=3` and `(2,1,2,1)=5` confirmed in DB — ede801b
- [x] 1.7 `leaderboard.exact_scores` counts only 5-point rows — ede801b

### Phase 2: Docs — align PRD + roadmap with 5/3/2/0

#### Automated

- [x] 2.1 No stale references: `rg -n "3 / 2 / 1|3-point|3 exact|3/2/1"` over `context/foundation` and `src` returns nothing about the old scheme (only the historical `shape-notes.md` discovery record retained by design)
- [x] 2.2 Lint passes: `npm run lint`

#### Manual

- [x] 2.3 FR-018/FR-020 + roadmap Q-01 read consistently at 5/3/2/0
