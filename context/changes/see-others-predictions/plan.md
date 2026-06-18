# See Others' Predictions (per-match reveal) — Implementation Plan

## Overview

Add a per-match **"See others' predictions"** control on the `/predictions` page. For any match that has kicked off (locked stage with no result yet, or a past match with a result), a participant can open a pop-up dialog listing every participant — in leaderboard standings order — with their prediction; once a result exists, the dialog also shows the result and each participant's points. This is the per-match complement to S-05's per-participant history view (`/history/[participantId]`).

The blindness invariant (FR-015/FR-017) is already enforced at the DB layer: the `predictions_select` RLS policy is owner-OR-`match_is_kicked_off`, so cross-participant predictions are only ever readable post-kickoff. This change adds **no migration and no RLS change** — it is a read query + UI.

## Current State Analysis

- `/predictions/index.astro` (`src/pages/predictions/index.astro`) server-renders the match list and loads **only the caller's own** predictions (`.eq("predictor_id", userId)`), passing `PredictionMatchRow[]` into the `PredictionList` React island (`client:load`). Each row carries `isPast` (computed `kickoff <= now()`).
- `PredictionList.tsx` renders, per match: an editable `PredictionForm` for future matches, or a read-only `LockedScore` (own score + "Locked") for kicked-off matches. The "See others'" trigger belongs next to `LockedScore`.
- `src/lib/history.ts` is the pattern to mirror: a **pure** `buildHistoryRows` (DB-free, unit-tested in `src/lib/history.test.ts`) + an async `loadHistory` that runs the session-client reads under RLS. Points are read from the `prediction_scores` view, never computed in TS.
- The `leaderboard` view (`supabase/migrations/20260605052647_results_scoring_leaderboard.sql:121`) returns **every** participant (LEFT JOIN `profiles_public`, so non-predictors appear) with `participant_id`, `display_name`, already ordered by the FR-020 tie-break (`total_points desc, exact_scores desc, lower(display_name) asc`). This is the single source for the ordered participant roster + names.
- The `prediction_scores` view (`...20260605052647...sql:99`) gives per-prediction `points` for matches that have a result; `security_invoker = true`, so it inherits the caller's RLS — safe to read for any participant.
- `match_results` (`...20260605052647...sql:31`) holds the result per match; publicly readable post-kickoff.
- No `dialog` exists in `src/components/ui/` (only `alert-dialog`, `popover`), but `radix-ui` is installed, so `npx shadcn@latest add dialog` adds the AGENTS-compliant primitive.
- RLS integration tests follow a fixed harness: `src/db/*.rls.test.ts`, `describe.skipIf(!dbConfigured)`, per-role signed-in clients, service-role for seeding post-kickoff rows, cleanup via tournament-cascade + `auth.admin.deleteUser`.

### Key Discoveries:

- **No DB work required.** `predictions_select` already gates cross-participant reads on kickoff (`supabase/migrations/20260604184657_predictions_with_blindness.sql:78`). Reading all predictions returns others' rows only for kicked-off matches.
- **Leaderboard order is free.** Selecting from the `leaderboard` view preserves the FR-020 ORDER BY without an explicit `.order()` (already relied on in `src/pages/leaderboard/index.astro:24`).
- **Non-predictor-with-result = 0 points** is the established semantic (`buildHistoryRows` sets `points = 0` when a result exists but no prediction — `src/lib/history.ts:97`). The dialog mirrors this.
- **Points come from the view, not TS** — reuse `prediction_scores`, never re-derive FR-018 in JavaScript.

## Desired End State

On `/predictions`, every kicked-off match row shows a "See others' predictions" button. Clicking it opens a modal dialog titled with the fixture, listing all participants in leaderboard order:

- **Locked, no result:** two columns — Participant, Prediction (`H–A` or "—" for non-predictors). The viewer's own row is visually marked ("you").
- **Result entered:** the result is shown in the dialog header; columns become Participant, Prediction, Points (predictor → scored points; non-predictor → `0`).
  Future (not-yet-kicked-off) matches show no button. Pre-kickoff predictions of other participants are never fetched or shown.

Verify: `npm run lint`, `npm run test`, `npm run build` all pass; the `match-predictions` unit test passes in default `npm test`; the new RLS test passes against a local Supabase stack; manual UI check on `/predictions` for a locked match and a resulted match.

## What We're NOT Doing

- No new migration, table, view, RLS policy, or column.
- No new Astro action or API endpoint (data is loaded eagerly server-side).
- No changes to the leaderboard, dashboard, or history pages/routes.
- No change to scoring logic (FR-018) — points are read from `prediction_scores` verbatim.
- No real-time / live updates; the dialog reflects the server render at page load.
- No per-match ordering option — ordering is global leaderboard standings only.

## Implementation Approach

Eager server-side load mirroring the existing SSR pattern. `/predictions/index.astro` gains a single helper call (`loadMatchPredictions`) that fetches the leaderboard roster, all readable predictions, results, and scores, then a pure builder assembles, per kicked-off match, an ordered participant list + the result. That data rides on each `PredictionMatchRow`; the `PredictionList` island renders a dialog trigger for kicked-off rows. The dialog is a presentational component fed already-loaded data — no client fetching, so the blindness boundary stays entirely server/DB-enforced.

## Phase 1: Data layer (`match-predictions.ts` + unit tests)

### Overview

Create the pure builder and the RLS-bound loader that produce, per kicked-off match, the leaderboard-ordered participant prediction rows and the match result.

### Changes Required:

#### 1. Match-predictions assembly module

**File**: `src/lib/match-predictions.ts` (new)

**Intent**: Mirror `src/lib/history.ts` — a DB-free pure merge plus an async loader — but pivoted on _match → participants_ instead of _participant → matches_. Points are read from `prediction_scores`, never computed.

**Contract**:

- Types:
  - `MatchPredictionParticipantRow { participantId: string; displayName: string; isSelf: boolean; prediction: { homeGoals: number; awayGoals: number } | null; points: number | null }`
  - `MatchPredictionsView { result: { homeScore: number; awayScore: number } | null; participants: MatchPredictionParticipantRow[] }`
- `buildMatchPredictionRows(input): Map<string, MatchPredictionsView>` — pure. Inputs: ordered roster `{ participantId, displayName }[]` (already in leaderboard order), `predictions { match_id, predictor_id, home_goals, away_goals }[]`, `results { match_id, home_score, away_score }[]`, `scores { match_id, predictor_id, points }[]`, the set/list of `kickedOffMatchIds`, and `viewerId`. For each kicked-off match it emits a `MatchPredictionsView` whose `participants` array follows roster order, each with their prediction (or `null`), `isSelf = participantId === viewerId`, and `points`: from `scores` when present; `0` when a result exists but the participant has no prediction (mirror of `history.ts:97`); else `null` (no result yet, or predicted-but-unresolved which cannot happen once a result exists). Index both `predictions` and `scores` by the **composite key `(match_id, predictor_id)`** — `history.ts` keyed by `match_id` alone because it was single-participant; here points are per-(match, participant), so a `match_id`-only key would mis-assign them.
- `loadMatchPredictions(supabase, viewerId, kickedOffMatchIds): Promise<Map<string, MatchPredictionsView>>` — runs the reads under RLS and returns the built map. Reads: `leaderboard` (`participant_id, display_name`, no explicit order — view carries it; unfiltered — the roster is the global standings), `predictions` (`match_id, predictor_id, home_goals, away_goals`), `match_results` (`match_id, home_score, away_score`), `prediction_scores` (`match_id, predictor_id, points`). Scope the latter three reads with `.in("match_id", kickedOffMatchIds)` as a **friendly mirror** of the RLS boundary (RLS is still the guard, never this filter — same philosophy as `history.ts`'s predictor `.eq`): it trims unresolved-match rows off the wire and keeps the loader's intent explicit. The empty-`kickedOffMatchIds` short-circuit (below) means `.in()` is never called with an empty list. **Null-coerce the view columns before building** (the generated types make view columns nullable, as handled at `leaderboard/index.astro:32-37` and `history.ts:157-162`): drop roster rows whose `participant_id` is null and coalesce `display_name`; skip `prediction_scores` rows with null `match_id`/`predictor_id`/`points` — so the roster and `scores` inputs reach the pure builder in their non-null shapes. Throws on the first query error (same throw-to-500 contract as `loadHistory`). Never uses the service-role client. If `kickedOffMatchIds` is empty, short-circuit to an empty map without querying.

#### 2. Unit tests for the pure builder

**File**: `src/lib/match-predictions.test.ts` (new)

**Intent**: Pin the merge rules that carry the real logic risk, mirroring `src/lib/history.test.ts`.

**Contract**: Cover — (a) participants appear in roster (leaderboard) order; (b) a participant with no prediction shows `prediction: null` and, when a result exists, `points: 0`; (c) `isSelf` set only for the viewer; (d) with a result present, predictors get their `scores` points and `result` is populated; (e) locked-no-result yields `points: null` for everyone and `result: null`; (f) only kicked-off matches appear in the map (a future match id not in `kickedOffMatchIds` is absent).

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build` (runs `astro check`)
- Linting passes: `npm run lint`
- Unit tests pass: `npm run test`

#### Manual Verification:

- `buildMatchPredictionRows` output ordering matches the leaderboard order for a hand-checked fixture.

**Implementation Note**: After automated verification passes, pause for manual confirmation before Phase 2.

---

## Phase 2: UI (dialog + wiring)

### Overview

Surface the data: add the shadcn `dialog` primitive, build the dialog component, render its trigger on kicked-off rows, and extend the predictions page to load and pass the data.

### Changes Required:

#### 1. Add the dialog primitive

**File**: `src/components/ui/dialog.tsx` (new, generated)

**Intent**: Provide a modal dialog primitive for an informational list pop-up.

**Contract**: Generate via `npx shadcn@latest add dialog` (new-york variant). Do not hand-author. No new npm dependency expected (`radix-ui` already present).

#### 2. Dialog component

**File**: `src/components/predictions/MatchPredictionsDialog.tsx` (new)

**Intent**: Presentational dialog that renders the leaderboard-ordered participant rows for one match from already-loaded props.

**Contract**: Props: `homeTeam`, `awayTeam`, `result: { homeScore; awayScore } | null`, `participants: MatchPredictionParticipantRow[]` (type imported from `@/lib/match-predictions`). Renders a `Dialog` with a trigger `Button` ("See others' predictions"), a title with the fixture, the result in the header/description when present, and a list/table of participants: Participant (with a "you" marker when `isSelf`), Prediction (`H–A` or "—"), and a Points column shown only when `result` is non-null. Mobile-friendly per the existing responsive table/list pattern (`src/pages/history/[participantId].astro`). Uses `cn()` for class composition.

#### 3. Render the trigger in the list

**File**: `src/components/predictions/PredictionList.tsx`

**Intent**: Show the dialog trigger on kicked-off rows, alongside the existing `LockedScore`.

**Contract**: Extend `PredictionMatchRow` with `result: { homeScore: number; awayScore: number } | null` and `participants: MatchPredictionParticipantRow[]` (populated only for `isPast` rows; empty/`null` otherwise). In the `match.isPast` branch, render `MatchPredictionsDialog` next to `LockedScore`, passing teams, `result`, and `participants`.

#### 4. Load and pass the data

**File**: `src/pages/predictions/index.astro`

**Intent**: Compute the kicked-off match ids, call `loadMatchPredictions`, and attach each match's view to its `PredictionMatchRow`.

**Contract**: After building `matchRows`, derive `kickedOffMatchIds` from rows where `isPast`. Call `loadMatchPredictions(supabase, userId, kickedOffMatchIds)`; on throw, `console.error` + `return new Response(..., { status: 500 })` (match the existing per-read error style). Map each kicked-off row's `result` and `participants` from the returned map; non-kicked-off rows get `result: null`, `participants: []`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run build`
- Linting passes: `npm run lint`
- Unit tests still pass: `npm run test`

#### Manual Verification:

- On `/predictions`, a locked match (no result) shows the button; the dialog lists all participants in leaderboard order, predictions or "—", own row marked "you", and no points column.
- A resulted match's dialog shows the result and a points column (predictors scored, non-predictors `0`).
- A future (not-kicked-off) match shows no button and no other-participant data.
- No horizontal overflow on a phone-width viewport; dialog is dismissible.

**Implementation Note**: After automated verification passes, pause for manual confirmation before Phase 3.

---

## Phase 3: RLS integration test

### Overview

Prove the read path reveals cross-participant predictions only post-kickoff and that the loader assembles them in leaderboard order.

### Changes Required:

#### 1. Live-DB RLS test

**File**: `src/db/match-predictions.rls.test.ts` (new)

**Intent**: Pin the blindness boundary and ordering for the new read path against a real local Supabase stack, mirroring `src/db/predictions.rls.test.ts` / `src/db/history.rls.test.ts`.

**Contract**: `describe.skipIf(!dbConfigured)` with the same env gating and helpers (`freshClient`, `signedInClient`, service-role seeding, tournament-cascade + `deleteUser` cleanup). Seed two participants (A, B) with distinct display names, a past match with a result + both predictions, and a future match A predicts via A's own session. Assert: (a) `loadMatchPredictions(B-session, B, [pastMatchId])` returns a view whose `participants` include A's revealed prediction and points, ordered by leaderboard standings; (b) the same loader called with the future match id returns no other participant's prediction for it (only B's own, `null` for others) — i.e. A's pre-kickoff pick never appears; (c) a direct `predictions` read for the future match from B's session returns zero of A's rows (blindness smoke).

### Success Criteria:

#### Automated Verification:

- Default suite still green (test self-skips without DB): `npm run test`
- Against a local stack, the new test passes:
  `SUPABASE_DB_URL=... SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... npm test -- match-predictions.rls`
- Linting passes: `npm run lint`

#### Manual Verification:

- Run the RLS test against `npx supabase start` and confirm all cases pass, including the ordering assertion.

---

## Testing Strategy

### Unit Tests:

- `buildMatchPredictionRows`: leaderboard ordering, "—" placeholder for non-predictors, `isSelf`, points sourcing from `scores`, `0` for non-predictor-with-result, `null` for locked-no-result, kicked-off-only inclusion.

### Integration Tests:

- `match-predictions.rls.test.ts`: cross-participant reveal only post-kickoff; future-match blindness; leaderboard-ordered assembly through `loadMatchPredictions`.

### Manual Testing Steps:

1. As a participant, open `/predictions`; for a locked (started, no result) match click "See others' predictions" → dialog lists everyone in leaderboard order, predictions or "—", own row marked.
2. After the admin enters a result, reopen the dialog → result shown, points column present (non-predictors `0`).
3. Confirm a future match has no button.
4. Resize to phone width → no overflow, dialog usable.

## Performance Considerations

Four small reads added to the predictions page render (leaderboard, predictions, results, scores), all under RLS, for a friend-group-sized dataset — negligible. Data is loaded once at render; the dialog does no further fetching.

**Accepted clock-skew boundary:** `kickedOffMatchIds` is derived from `isPast` (app-server `Date.now()` in the `.astro` frontmatter), while the actual reveal is gated by `match_is_kicked_off` (DB `now()`). In the few seconds around kickoff, skew could surface the button (isPast true) before RLS reveals others' rows — the dialog would briefly show only the viewer, everyone else as "—". This is the same `isPast` boundary the existing `LockedScore`/`PredictionForm` split already relies on (no regression), it degrades gracefully, and it self-heals on the next render. Accepted as-is — no clock reconciliation.

## Migration Notes

None — no schema or data changes.

## References

- Change identity: `context/changes/see-others-predictions/change.md`
- Pattern to mirror (data): `src/lib/history.ts`, `src/lib/history.test.ts`
- Pattern to mirror (RLS test): `src/db/predictions.rls.test.ts`, `src/db/history.rls.test.ts`
- Leaderboard order + scoring views: `supabase/migrations/20260605052647_results_scoring_leaderboard.sql`
- Blindness policy: `supabase/migrations/20260604184657_predictions_with_blindness.sql:78`
- Consuming page + island: `src/pages/predictions/index.astro`, `src/components/predictions/PredictionList.tsx`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Data layer (match-predictions.ts + unit tests)

#### Automated

- [x] 1.1 Type checking passes: `npm run build` — 6ed3345
- [x] 1.2 Linting passes: `npm run lint` — 6ed3345
- [x] 1.3 Unit tests pass: `npm run test` — 6ed3345

#### Manual

- [x] 1.4 buildMatchPredictionRows output ordering matches leaderboard order for a hand-checked fixture — 6ed3345

### Phase 2: UI (dialog + wiring)

#### Automated

- [x] 2.1 Type checking passes: `npm run build`
- [x] 2.2 Linting passes: `npm run lint`
- [x] 2.3 Unit tests still pass: `npm run test`

#### Manual

- [x] 2.4 Locked match: button + dialog list in leaderboard order, predictions or "—", own row marked, no points column
- [x] 2.5 Resulted match: dialog shows result + points column (non-predictors 0)
- [x] 2.6 Future match shows no button / no other-participant data
- [x] 2.7 No horizontal overflow on phone width; dialog dismissible

### Phase 3: RLS integration test

#### Automated

- [ ] 3.1 Default suite still green (self-skips without DB): `npm run test`
- [ ] 3.2 Against a local stack the new test passes: `npm test -- match-predictions.rls`
- [ ] 3.3 Linting passes: `npm run lint`

#### Manual

- [ ] 3.4 Run the RLS test against a local Supabase stack; all cases pass including ordering
