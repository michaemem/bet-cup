# Fix "See Others' Predictions" Zero-Points Bug (Row-Cap Truncation) Implementation Plan

## Overview

The predictions page's "See others' predictions" dialog shows `0 pts` for
participants who actually scored points, while the leaderboard shows correct
totals. The cause is Supabase's `max_rows = 1000` cap silently truncating the
two all-participants reads in `loadMatchPredictions`. This plan paginates those
reads so they always return every row, makes a genuinely-missing score render as
`—` instead of a fake `0`, and locks both behaviors in with unit + live-DB
tests.

## Current State Analysis

`loadMatchPredictions` (`src/lib/match-predictions.ts:128-190`) runs four reads
under RLS and merges them:

- `roster` — from the `leaderboard` view, one row per participant, carrying the
  FR-020 tie-break `ORDER BY`. Bounded by participant count.
- `predictions` — `.in("match_id", kickedOffMatchIds)`, **fans out to
  `participants × kicked-off matches` rows**. No `.range()`.
- `results` — `.in("match_id", kickedOffMatchIds)`, one row per match (unique
  `match_id`). Bounded by match count.
- `scores` — `prediction_scores` `.in("match_id", kickedOffMatchIds)`, **fans
  out to `predictors-with-a-prediction × resulted matches` rows**. No `.range()`.

`supabase/config.toml:18` sets `max_rows = 1000` (this is the local stack; the
hosted project has the same PostgREST setting). Any read whose result exceeds
1000 rows is silently truncated to the first 1000 — no error is raised. Once
`participants × kicked-off matches` crosses ~1000, the `predictions` and
`scores` reads drop rows. When a `(match_id, predictor_id)` score row is
dropped, `buildMatchPredictionRows` (`src/lib/match-predictions.ts:97-104`)
falls through to `points = null`, and the dialog renders
`participant.points ?? 0` (`src/components/predictions/MatchPredictionsDialog.tsx:63`)
as `0` — indistinguishable from a legitimately-scored 0.

### Key Discoveries:

- **The cap is explicit**: `supabase/config.toml:18` → `max_rows = 1000`.
- **Only the two fan-out reads exceed it**: `predictions` and `prediction_scores`
  are `O(participants × matches)`. `results` is `O(matches)`; `roster` is
  `O(participants)` — both safely under 1000 for a private pool.
- **The leaderboard is immune** because it reads the pre-aggregated `leaderboard`
  view (one row per participant), never the raw per-match rows.
- **`history.ts` is immune** — its reads filter by a single
  `.eq("predictor_id", …)` (`src/lib/history.ts:143,154`), so they are
  `O(matches)`.
- **The builder is already correct**: `buildMatchPredictionRows` returns `null`
  for missing points; the masking happens only in the dialog's `?? 0`
  (confirmed by `src/lib/match-predictions.test.ts` cases (b) and (e)).
- **No React testing-library in deps** (`package.json`) — vitest runs on
  happy-dom. Display logic is therefore extracted to a pure helper to stay
  unit-testable without a new dependency, mirroring `buildMatchPredictionRows` /
  `buildHistoryRows`.
- **Test pattern for the cap**: the live-DB RLS test
  (`src/db/match-predictions.rls.test.ts`) seeds via the service-role client and
  self-skips unless `SUPABASE_DB_URL` + keys are set.

## Desired End State

`loadMatchPredictions` returns complete `predictions` and `scores` sets no matter
how large the tournament grows; every scored participant shows their real points
in the dialog; and a genuinely-missing score renders as `—`, not `0`. Verified
by a fast unit test on the pagination helper (CI) and a live-DB test that crosses
the 1000-row cap (local/opt-in).

## What We're NOT Doing

- Not raising `max_rows` in `config.toml` or the hosted project settings (a
  band-aid that just moves the ceiling).
- Not refactoring to per-match on-demand fetching / a new API route.
- Not changing scoring, RLS policies, the `prediction_scores`/`leaderboard`
  views, or any migration.
- Not paginating the `roster` (leaderboard) read — it is bounded by participant
  count and carries the FR-020 implicit `ORDER BY` we must not disturb. Bound
  noted in Open Risks.
- Not changing the SSR data-loading architecture of `predictions/index.astro`.

## Implementation Approach

Introduce one small, generic, pure-ish pagination helper that loops
`.range(from, to)` requests until a short page is returned, then apply it to the
two fan-out reads. Because page boundaries across separate HTTP requests must be
stable, each paginated read applies a deterministic `.order()`. Keep the merge
(`buildMatchPredictionRows`) untouched — it already handles the assembled arrays
correctly. Separately, stop the dialog from coercing `null → 0` by routing the
points cell through a pure `formatPoints` helper.

## Critical Implementation Details

- **Deterministic ordering is load-bearing for pagination.** PostgREST paging
  with `.range()` only yields a correct, gap-free/duplicate-free union if the
  query has a stable total order. Each paginated read MUST add an explicit
  `.order()` on a deterministic key (e.g. `predictions` by `match_id` then
  `predictor_id`; `prediction_scores` by `match_id` then `predictor_id`).
  Without it, rows can be skipped or repeated across pages.
- **Page size must be ≤ `max_rows`.** Requesting a range wider than the server
  cap still returns at most `max_rows` rows, which would make the "short page ⇒
  done" termination misfire. Use a page size of 1000 (equal to the cap): a full
  page returns exactly 1000, a partial/last page returns fewer, which is the
  stop signal.
- **The `roster` read must keep NO explicit `.order()`** — it inherits the
  `leaderboard` view's FR-020 tie-break ordering, which the live ordering test
  (`match-predictions.rls.test.ts` case (a)) depends on.

## Phase 1: Paginated Reads (Core Fix)

### Overview

Add a generic paged-read helper and use it for the `predictions` and
`prediction_scores` reads so neither is ever truncated at 1000 rows.

### Changes Required:

#### 1. Pagination helper

**File**: `src/lib/paginate.ts` (new)

**Intent**: Provide a reusable function that reads all rows of a query in
fixed-size pages until exhausted, so callers are never silently capped by
PostgREST's `max_rows`. Pure with respect to Supabase — it takes a page-fetching
callback so it can be unit-tested without a live DB.

**Contract**: Export `readAllPages<T>(fetchPage, pageSize?)` where
`fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>`
and `pageSize` defaults to 1000. It requests `[0..pageSize-1]`, `[pageSize..2*pageSize-1]`,
… accumulating `data`; stops when a page returns fewer than `pageSize` rows (or
empty/null); throws (mirroring the loaders' `throw new Error(…, { cause })`
style) if any page returns an `error`. Returns the concatenated `T[]`.

#### 2. Apply pagination to the fan-out reads

**File**: `src/lib/match-predictions.ts`

**Intent**: Replace the single-shot `predictions` and `prediction_scores` reads
in `loadMatchPredictions` with `readAllPages` calls so all rows are fetched
regardless of tournament size. Add a deterministic `.order()` to each so page
boundaries are stable. Leave `roster` and `results` as single reads.

**Contract**: `loadMatchPredictions` keeps its signature and return type. The
`predictions` read becomes a `readAllPages` loop over
`supabase.from("predictions").select(...).in("match_id", kickedOffMatchIds).order("match_id").order("predictor_id").range(from, to)`;
the `scores` read likewise over `prediction_scores` with the same ordering keys.
Existing error-to-throw semantics preserved (helper throws on page error). The
downstream sanitization loops and `buildMatchPredictionRows` call are unchanged.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Unit tests pass: `npm test`
- New helper unit test proves multi-page stitching returns the full set (e.g.
  2,050 fake rows across 1000-row pages → 2,050 returned) and that a single
  short page terminates immediately.

#### Manual Verification:

- On a dataset exceeding 1000 `participants × kicked-off matches`, opening "See
  others' predictions" shows correct non-zero points for scored participants.
- Points shown per participant match that participant's leaderboard contribution.

**Implementation Note**: After completing this phase and all automated
verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Defensive Points Display

### Overview

Stop the dialog from rendering a missing (`null`) score as `0`, so any future
truncation or data gap is visible rather than silent.

### Changes Required:

#### 1. Points formatting helper

**File**: `src/lib/match-predictions.ts` (or a small colocated pure helper)

**Intent**: Add a pure function that formats a participant's points for display,
distinguishing "no score" from "scored zero", so it can be unit-tested without
rendering React.

**Contract**: Export `formatPoints(points: number | null): string` returning
`"—"` when `points` is `null` and `` `${points} pts` `` otherwise (a real `0`
→ `"0 pts"`).

#### 2. Use the helper in the dialog

**File**: `src/components/predictions/MatchPredictionsDialog.tsx`

**Intent**: Replace the `{participant.points ?? 0} pts` expression with the
`formatPoints` helper so `null` renders as `—`.

**Contract**: The points `<span>` (currently line 63) renders
`formatPoints(participant.points)`; the `showPoints` gate (`result !== null`) is
unchanged. No prop shape changes.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx astro check`
- Linting passes: `npm run lint`
- Unit tests pass: `npm test`
- New `formatPoints` unit test covers `null → "—"`, `0 → "0 pts"`, and a
  positive value.

#### Manual Verification:

- For a resulted match, a participant who did not predict shows `0 pts`
  (real zero), and no scored participant shows `—`.

**Implementation Note**: After completing this phase and all automated
verification passes, pause for manual confirmation before proceeding.

---

## Phase 3: Live-DB Regression Test

### Overview

Prove end-to-end against a real Supabase stack that crossing the 1000-row cap no
longer drops points.

### Changes Required:

#### 1. Over-the-cap regression case

**File**: `src/db/match-predictions.rls.test.ts`

**Intent**: Add a test that seeds enough `participants × kicked-off resulted
matches` to exceed 1000 prediction/score rows, then asserts `loadMatchPredictions`
returns non-null, correct points for every seeded participant across the seeded
matches (i.e. no truncation). Keep the existing self-skip-without-DB guard and
service-role seeding pattern.

**Contract**: New `it(...)` (or `describe`) block within the existing
`describe.skipIf(!dbConfigured)` suite. Seeds via the service-role client (bulk
insert of predictions + results across the seeded matches), calls
`loadMatchPredictions(viewer, viewerId, seededKickedOffMatchIds)`, and asserts
the count of participant rows with non-null points equals the expected seeded
count and no scored participant is `null`/`0`-by-truncation. Cleans up seeded
tournament + users in `afterAll` (existing teardown extended).

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Default `npm test` still passes and skips the live-DB suite when DB env is
  unset.
- With local Supabase running and env set, the over-cap test passes:
  `SUPABASE_DB_URL=… SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… npm test -- match-predictions.rls`

#### Manual Verification:

- The over-cap test fails against the pre-fix loader (temporarily reverting
  Phase 1) — confirming it actually guards the regression.

**Implementation Note**: After completing this phase and all automated
verification passes, pause for manual confirmation.

---

## Testing Strategy

### Unit Tests:

- `readAllPages`: multi-page stitching returns the full set; short first page
  terminates; page error throws; empty result returns `[]`.
- `formatPoints`: `null → "—"`, `0 → "0 pts"`, positive → `"N pts"`.
- Existing `buildMatchPredictionRows` cases remain green (merge unchanged).

### Integration Tests:

- Live-DB over-cap regression in `match-predictions.rls.test.ts` (opt-in).
- Existing reveal + ordering + blindness live-DB cases remain green.

### Manual Testing Steps:

1. On a tournament with `participants × kicked-off matches > 1000`, open "See
   others' predictions" for a resulted match; confirm scored participants show
   real points, not `0`.
2. Cross-check a sampled participant's per-match points against their leaderboard
   total.
3. Confirm a non-predictor on a resulted match shows `0 pts` and a predicted-but-
   unresolved match shows no points column.

## Performance Considerations

Pagination adds one extra round-trip only when a read exceeds 1000 rows; typical
private-pool data stays within a single page. Deterministic `.order()` on
`match_id`/`predictor_id` is index-supported (`predictions_match_id_idx`,
`predictions_predictor_id_idx`).

## Migration Notes

None — no schema, migration, RLS, or view changes.

## References

- Change identity / diagnosis: `context/changes/match-predictions-row-cap/change.md`
- Loader: `src/lib/match-predictions.ts:128-190`
- Merge + null handling: `src/lib/match-predictions.ts:97-104`
- Dialog masking: `src/components/predictions/MatchPredictionsDialog.tsx:63`
- Row cap: `supabase/config.toml:18`
- Immune sibling (single-predictor reads): `src/lib/history.ts:143,154`
- Test patterns: `src/lib/match-predictions.test.ts`, `src/db/match-predictions.rls.test.ts`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Paginated Reads (Core Fix)

#### Automated

- [x] 1.1 Type checking passes: `npx astro check` — a11ea78
- [x] 1.2 Linting passes: `npm run lint` — a11ea78
- [x] 1.3 Unit tests pass: `npm test` — a11ea78
- [x] 1.4 `readAllPages` unit test proves multi-page stitching + short-page termination — a11ea78

#### Manual

- [x] 1.5 Over-1000-row dataset shows correct non-zero points in the dialog
- [x] 1.6 Per-participant points match their leaderboard contribution

### Phase 2: Defensive Points Display

#### Automated

- [x] 2.1 Type checking passes: `npx astro check` — f3afe12
- [x] 2.2 Linting passes: `npm run lint` — f3afe12
- [x] 2.3 Unit tests pass: `npm test` — f3afe12
- [x] 2.4 `formatPoints` unit test covers null/0/positive — f3afe12

#### Manual

- [x] 2.5 Non-predictor on resulted match shows `0 pts`; no scored participant shows `—`

### Phase 3: Live-DB Regression Test

#### Automated

- [x] 3.1 Linting passes: `npm run lint` — 447323c
- [x] 3.2 Default `npm test` passes and skips live-DB suite without DB env — 447323c
- [x] 3.3 Over-cap live-DB test passes with local Supabase + env set — 447323c

#### Manual

- [x] 3.4 Over-cap test fails against the pre-fix loader (guards the regression) — 447323c
