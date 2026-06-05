# Participant Match History (S-05) — Implementation Plan

## Overview

Add a read-only match-by-match history for participants (FR-021): for each match a participant sees their prediction, the actual result once the admin has entered it, and the points they earned; before a result exists only the prediction shows. Extend this so a participant can also view **any other participant's revealed (post-kickoff) history** (new FR-021b), reached by clicking a name on the leaderboard. The slice is built entirely on S-04's shipped data layer (`prediction_scores`, `match_results`, `predictions`, `matches`) with **no new migration**; points are always read from the SQL `prediction_scores` view, never recomputed in TypeScript.

## Current State Analysis

- **The scoring/result data layer exists and is sufficient.** S-04 shipped `match_results`, `score_prediction()`, and two `security_invoker = true` views — `prediction_scores` (per-prediction points) and `leaderboard` (aggregates) — all `authenticated`-granted (`supabase/migrations/20260605052647_results_scoring_leaderboard.sql:31-140`). No app code reads `prediction_scores` yet; this slice is its first consumer.
- **Blindness for cross-participant reads is DB-enforced.** `predictions_select USING (predictor_id = auth.uid() OR public.match_is_kicked_off(match_id))` (`supabase/migrations/20260604184657_predictions_with_blindness.sql:78-81`), no `is_admin()` branch. Filtering `predictions` by another participant's id returns **only their kicked-off picks**; pre-kickoff predictions are invisible at the database layer.
- **`prediction_scores` only contains resulted matches** (it INNER JOINs `match_results`, `:99-111`), and results can only be written post-kickoff (`match_results_insert/update with check is_admin() AND match_is_kicked_off`, `:61-70`). So result-less matches must come from a separate `matches` (+ `predictions`) read — the merge-in-frontmatter pattern from `src/pages/predictions/index.astro:44-66`.
- **`match_results` and `matches` are world-readable** to authenticated users (`match_results_select USING (true)`, `matches_select_all USING (true)`), so fixture labels and actual scores are freely joinable for any participant's history.
- **All page/UI patterns exist to clone.** Leaderboard SSR + raw table + empty states (`src/pages/leaderboard/index.astro:5-83`); session client `createClient(Astro.request.headers, Astro.cookies)` (`src/lib/supabase.ts:8-27`); time display via `formatInZone(utc, tournament.time_zone)` (`src/lib/time.ts:97-108`) with `isPast = new Date(kickoff_time).getTime() <= Date.now()`; dashboard nav (`src/pages/dashboard.astro:17-29`).
- **No middleware change needed.** Default-deny gate (`src/middleware.ts:4-12`) auto-protects a new `/history` route; it is not under `/admin`, so no admin gate.

### Key Discoveries:

- Points must be read from `prediction_scores` (`supabase/migrations/20260605052647_results_scoring_leaderboard.sql:99-111`), not recomputed — the codebase keeps FR-018 in one place (SQL), and `context/foundation/lessons.md` warns against logic drift.
- `profiles_public` exposes `display_name` but **not** `username` (`context/archive/2026-06-03-admin-creates-participants/reviews/impl-review.md:85`); the "viewing X's history" header and leaderboard links must use `display_name` + `participant_id` (both already selected in `src/pages/leaderboard/index.astro:25-37`).
- The running total per participant equals their `leaderboard.total_points` by construction (same `prediction_scores` source) — a cheap consistency invariant to assert.

## Desired End State

A logged-in participant opens **My history** from the dashboard and sees a table of their matches: prediction, actual result (when entered), and points — with a running total that matches their leaderboard total. Clicking any name on the leaderboard opens that participant's history showing only kicked-off matches (their revealed predictions + results + points), never their future picks. PRD FR-021b and the roadmap S-05 section document the cross-participant capability. Verify: type-check/lint/build pass; the `buildHistoryRows` unit test passes; the cross-participant blindness + total-consistency DB test passes in the CI `rls` job; manual walk-through confirms the visibility matrix below.

### Visibility matrix (the load-bearing contract)

| Match state | Own history (`/history`) | Other (`/history/[participantId]`) |
|---|---|---|
| Not kicked off, you/they predicted | prediction; no result; no points | **row hidden** (blindness) |
| Not kicked off, no prediction | row hidden | row hidden |
| Kicked off, predicted, no result | prediction; no result; no points | prediction; no result; no points |
| Result entered, predicted | prediction + result + points | prediction + result + points |
| Result entered, no prediction | "no prediction"; result; 0 pts | "no prediction"; result; 0 pts |

Listing rule (both pages): **show a match iff the viewed participant has a prediction for it OR a result exists.** For the other-participant page this naturally yields kicked-off matches only, because RLS returns their predictions only post-kickoff and results exist only post-kickoff.

## What We're NOT Doing

- No new migration, table, or SQL view (frontmatter merge over existing objects).
- No recomputation of FR-018 in TypeScript — points come from `prediction_scores`.
- No editing of predictions/results from the history page (read-only); no admin surface changes.
- No listing of future fixtures a participant has not predicted (per user decision).
- No real-time updates (PRD Non-Goal); history reflects state on page load.
- No `username` exposure; no widening of `profiles_public` or any RLS policy.
- No in-page participant selector (drill-in is via leaderboard names + nested route).
- No new shadcn dependency (raw HTML table, per leaderboard precedent).

## Implementation Approach

DB reads already exist, so this is a UI/composition slice. Phase 1 settles the documentation contract (FR-021b + roadmap). Phase 2 builds a shared, pure row-builder plus the own-history page and dashboard link. Phase 3 adds the other-participant route and wires leaderboard names to it. Phase 4 pins the integrity invariants (blindness + total consistency) and the row-builder logic with tests. Each phase is independently verifiable.

## Critical Implementation Details

- **Points come from `prediction_scores`, not TS.** The row-builder receives per-match points as input (queried from the view) and must not re-derive them; this preserves the single SQL source of truth for FR-018 and avoids the drift `lessons.md` warns about.
- **Blindness is the DB's job; the app filter is a friendly mirror.** The other-participant page relies on `predictions` RLS to exclude pre-kickoff picks. Do not add an app-layer kickoff filter as the security boundary, and never use the service-role client here — all reads use the session client under RLS.
- **Time zone binds to `tournaments.time_zone`.** Format kickoff via `formatInZone(utc, zone)`; never hardcode a zone (S-02 impl-review F1).

---

## Phase 1: PRD & roadmap amendment

### Overview

Document the cross-participant viewing capability and the refined listing rule before code, so the built behavior matches the written contract.

### Changes Required:

#### 1. Add FR-021b to the PRD

**File**: `context/foundation/prd.md`

**Intent**: Record cross-participant revealed-history viewing as a first-class requirement while keeping FR-021 (own history) intact for traceability.

**Contract**: Under `### Scoring & Leaderboard`, after FR-021 (`:116`), add `FR-021b` (must-have): a participant can view any other participant's match-by-match history for matches whose kickoff has passed; pre-kickoff predictions remain hidden per FR-015. Optionally note the listing rule (a match appears when the viewed participant has a prediction or a result exists). Keep FR-021 wording unchanged.

#### 2. Update the roadmap S-05 entry

**File**: `context/foundation/roadmap.md`

**Intent**: Reflect the extended scope and the refined listing rule in the slice's index row and detail section.

**Contract** (target headings, not line numbers — the roadmap shifts): In the **"At a glance"** table, S-05 row, extend the PRD refs to `FR-021, FR-021b` and broaden the outcome text to include viewing other participants' revealed history. In the **`### S-05`** section, update **Outcome** to: (a) own history shows prediction/result/points with future-unpredicted matches omitted, and (b) any other participant's history is viewable for kicked-off matches only (blindness preserved). Add `FR-021b` to the section's **PRD refs**. Mirror the PRD-ref change in the **Backlog Handoff** table's S-05 row if present.

### Success Criteria:

#### Automated Verification:

- No broken internal references introduced (docs only): `npm run lint` still passes (lint ignores markdown, so this is a no-op guard).

#### Manual Verification:

- `context/foundation/prd.md` contains FR-021b and FR-021 is unchanged.
- `context/foundation/roadmap.md` S-05 row and section mention FR-021b and the refined listing rule.

---

## Phase 2: Own history page (`/history`)

### Overview

A shared pure row-builder plus the own-history SSR page reading the caller's data under RLS, with a dashboard entry point.

### Changes Required:

#### 1. Shared history loader + pure row-builder

**File**: `src/lib/history.ts` (new)

**Intent**: Centralize the merge of matches + predictions + results + points into display rows so both history pages share one tested code path; keep the merge logic pure (DB-free) for unit testing.

**Contract**: Export `HistoryRow` = `{ matchId: string; homeTeam: string; awayTeam: string; kickoffLocal: string; isPast: boolean; prediction: { homeGoals: number; awayGoals: number } | null; result: { homeScore: number; awayScore } | null; points: number | null }` and a `HistorySummary` = `{ rows: HistoryRow[]; totalPoints: number }`. Export a pure `buildHistoryRows(input)` that takes `{ matches, predictions, results, scores, zone }` (plain arrays/maps keyed by `match_id`, plus the IANA `zone`) and returns `HistorySummary`: include a match iff a prediction exists for the viewed participant **or** a result exists; map `points` from the `scores` (`prediction_scores`) input when present, else `0` when a result exists but no prediction, else `null`; compute `totalPoints` as the sum of non-null points; order by `kickoff_time` ascending; format `kickoffLocal` via `formatInZone`. Export an async `loadHistory(supabase, targetUserId, zone)` that runs the four session-client queries (`matches`; `predictions` filtered `.eq("predictor_id", targetUserId)`; `match_results`; `prediction_scores` filtered `.eq("predictor_id", targetUserId)`) and returns `buildHistoryRows(...)`. **Error behavior**: check each query's `{ error }` and `throw` on the first non-null error (e.g. `throw new Error("history: failed to load <relation>")`), so the per-read error channel from `predictions/index.astro` is preserved through a single entry point; callers wrap the call in try/catch and map a throw to a 500. Points are never computed here — only read from `prediction_scores`.

#### 2. Own history page

**File**: `src/pages/history/index.astro` (new; clone `src/pages/leaderboard/index.astro` shell)

**Intent**: Render the caller's own history table with a running total.

**Contract**: SSR with `createClient(Astro.request.headers, Astro.cookies)` and `Astro.locals.user?.id`. Load the single tournament's `time_zone` (pattern from `src/pages/predictions/index.astro:18-22`); call `loadHistory(supabase, userId, zone)` inside a try/catch; on a thrown query error log it and `return new Response("Failed to load history", { status: 500 })`. Render a raw `<table>` (match, kickoff, your prediction, result, points) inside the `Layout` + `main.mx-auto.max-w-3xl.space-y-6.p-6` shell with a "Back to dashboard" link; show predictions as `H–A`, result as `H–A` or `—`, points or `—`; render a running-total row/footer. Empty state when no rows: "No history yet — your predictions and results will appear here." Use `tabular-nums`/`text-muted-foreground` per leaderboard precedent.

#### 3. Dashboard link

**File**: `src/pages/dashboard.astro`

**Intent**: Make the history page reachable for all participants.

**Contract**: Add a "My history" link to the participant nav row (`:17-29`), styled like the existing "My predictions"/"Leaderboard" links, pointing to `/history`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Linting passes: `npm run lint`
- Production build passes: `npm run build`

#### Manual Verification:

- `/history` shows the caller's predicted matches; a predicted-but-not-yet-resulted match shows the prediction with no result/points.
- A resulted match shows prediction + result + points; the running total equals the caller's leaderboard total.
- A future match the caller has not predicted does not appear.
- "My history" link appears on the dashboard and routes correctly; unauthenticated access redirects to sign-in.

---

## Phase 3: Cross-participant drill-in (`/history/[participantId]`)

### Overview

A nested dynamic route reusing `loadHistory`, plus leaderboard name links as the entry point.

### Changes Required:

#### 1. Other-participant history page

**File**: `src/pages/history/[participantId].astro` (new)

**Intent**: Show any participant's revealed history, relying on RLS for the blindness boundary.

**Contract**: SSR; read `participantId` from `Astro.params`. If it equals the caller's own id, redirect to `/history` (canonical own view). Look up the target's `display_name` from `profiles_public` (`.eq("id", participantId).maybeSingle()`); treat **no usable row** — whether `data` is null OR `error` is non-null (a non-UUID path like `/history/abc` raises Postgres `22P02 invalid input syntax for type uuid`, which surfaces as `error`, not `data: null`) — as not-found: render a friendly "Participant not found." (or `new Response(..., { status: 404 })`). (A cheap `if (!/^[0-9a-f-]{36}$/i.test(participantId))` short-circuit before the query is an acceptable equivalent.) Call `loadHistory(supabase, participantId, zone)` inside a try/catch (on a thrown query error log it and `return new Response("Failed to load history", { status: 500 })`) — RLS ensures only the target's kicked-off predictions return, so the listing rule yields revealed matches only. Render the **same table** as Phase 2 with a header "{display_name}'s history" and a "Back to leaderboard" link. Empty state: "No revealed history yet." (when the participant has no kicked-off predictions and no results to show).

#### 2. Link leaderboard names to history

**File**: `src/pages/leaderboard/index.astro`

**Intent**: Provide the drill-in entry point chosen in research.

**Contract**: Wrap each participant's `display_name` cell (`:73-79`) in an `<a href={`/history/${row.participantId}`}>` (underline/`hover` styling consistent with existing links). The caller's own row may link to `/history` (the `[participantId]` page redirects self → `/history` regardless, so a uniform `/history/${participantId}` link is acceptable).

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Linting passes: `npm run lint`
- Production build passes: `npm run build`

#### Manual Verification:

- Clicking a name on `/leaderboard` opens that participant's history.
- Another participant's page lists only kicked-off matches; it never shows a pre-kickoff prediction (verify with a match that has not kicked off).
- A kicked-off-but-unresulted match shows the other participant's revealed prediction with no result/points.
- Visiting `/history/<own-id>` redirects to `/history`; an unknown id (valid-UUID-but-no-such-participant) AND a malformed non-UUID id (e.g. `/history/abc`) both show the not-found state.

---

## Phase 4: Tests (blindness + consistency + row logic)

### Overview

Pin the integrity invariants and the row-builder rules.

### Changes Required:

#### 1. Row-builder unit test

**File**: `src/lib/history.test.ts` (new; pure unit test, runs in default CI)

**Intent**: Lock the listing rule, points mapping, ordering, and running-total math without a DB.

**Contract**: Feed `buildHistoryRows` mock inputs covering: predicted+resulted → points from `scores`; predicted+no-result → `points: null`, included; resulted+no-prediction → `points: 0`, label-able as no prediction, included; no-prediction+no-result → excluded; ordering by kickoff; `totalPoints` = sum of non-null points. Assert each case.

#### 2. Cross-participant blindness + consistency DB test

**File**: `src/db/history.rls.test.ts` (new; mirror `src/db/results-scoring.rls.test.ts` / `predictions.rls.test.ts` harness — `describe.skipIf(!dbConfigured)`, service-role setup client + per-role signed-in clients)

**Intent**: Prove the history reads cannot leak a pre-kickoff prediction and that a participant's history total equals their leaderboard total.

**Contract**: Seed ≥2 participants, a future match and a kicked-off match (one with a result), and predictions. The **centerpiece** assertion is consistency (the roadmap's named top risk for S-05): as participant A's session client, `sum(prediction_scores.points where predictor_id = B)` equals `leaderboard.total_points` for B. Keep the blindness portion **thin** — a single history-read-path smoke assertion that `prediction_scores` filtered to B returns **zero rows for the future match** — rather than re-proving the `predictions` SELECT policy (already exhaustively covered by `predictions.rls.test.ts`). This complements, not duplicates, the existing blindness test.

#### 3. CI coverage

**File**: `.github/workflows/ci.yml`

**Intent**: Ensure both lanes run.

**Contract**: `history.test.ts` runs in the default unit lane; `history.rls.test.ts` matches the existing `rls` job filter by filename (`:86-116`). Confirm no workflow edit is needed.

### Success Criteria:

#### Automated Verification:

- Unit suite passes: `npm test`
- Row-builder test passes: `npm test -- history`
- DB/RLS suite passes with Supabase up: `npm test -- rls`
- Type checking passes: `npm run lint`
- Linting passes: `npm run lint`

#### Manual Verification:

- With the local stack up, the `history.rls.test.ts` blindness assertions fail if the `predictor_id` filter is removed from the loader (sanity check that the test has teeth).

---

## Testing Strategy

### Unit Tests:

- `buildHistoryRows`: inclusion rule (prediction-or-result), points mapping (from `scores`, 0 on resulted-no-prediction, null on unresolved), ordering, running total.

### Integration / DB Tests (CI `rls` job):

- Cross-participant blindness on the history read path: no pre-kickoff prediction of another participant is ever returned.
- Consistency: a participant's summed history points equal their `leaderboard.total_points`.

### Manual Testing Steps:

1. As a participant, predict a future match → it appears on `/history` with no result/points; a future match you didn't predict is absent.
2. As admin, enter that match's result after kickoff → the participant's `/history` row gains result + points; running total matches `/leaderboard`.
3. From `/leaderboard`, click another participant → see their revealed history; confirm no pre-kickoff prediction is shown.
4. Visit `/history/<own-id>` → redirected to `/history`; visit an invalid id → not-found state.

## Performance Considerations

Four small indexed reads per page load at MVP scale (5–20 users, low QPS). `predictions(match_id)`/`(predictor_id)`, `match_results.match_id` unique, and `matches(tournament_id, kickoff_time)` indexes cover the joins. Negligible; revisit only well beyond MVP.

## Migration Notes

None — no schema change. Pure read feature over S-04's objects.

## References

- Related research: `context/changes/participant-match-history/research.md`
- Scoring/leaderboard data layer: `supabase/migrations/20260605052647_results_scoring_leaderboard.sql:31-140`
- Blindness RLS: `supabase/migrations/20260604184657_predictions_with_blindness.sql:60-92`
- Leaderboard page (clone shell + link names): `src/pages/leaderboard/index.astro:5-83`
- Predictions page (frontmatter merge precedent): `src/pages/predictions/index.astro:44-66`
- Time formatting: `src/lib/time.ts:97-108`
- Dashboard nav: `src/pages/dashboard.astro:17-29`
- CI `rls` job: `.github/workflows/ci.yml:86-116`
- PRD FR-021: `context/foundation/prd.md:116`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: PRD & roadmap amendment

#### Automated

- [x] 1.1 Lint passes (docs-only guard): `npm run lint` — 4f23dda

#### Manual

- [x] 1.2 `prd.md` contains FR-021b; FR-021 unchanged — 4f23dda
- [x] 1.3 `roadmap.md` S-05 row and section mention FR-021b and the refined listing rule — 4f23dda

### Phase 2: Own history page (`/history`)

#### Automated

- [x] 2.1 Type checking passes: `npm run lint`
- [x] 2.2 Linting passes: `npm run lint`
- [x] 2.3 Production build passes: `npm run build`

#### Manual

- [x] 2.4 `/history` shows predicted matches; predicted-but-unresulted shows prediction only
- [x] 2.5 Resulted match shows prediction + result + points; running total equals leaderboard total
- [x] 2.6 Future unpredicted match does not appear
- [x] 2.7 Dashboard "My history" link works; unauthenticated access redirects to sign-in

### Phase 3: Cross-participant drill-in (`/history/[participantId]`)

#### Automated

- [ ] 3.1 Type checking passes: `npm run lint`
- [ ] 3.2 Linting passes: `npm run lint`
- [ ] 3.3 Production build passes: `npm run build`

#### Manual

- [ ] 3.4 Clicking a leaderboard name opens that participant's history
- [ ] 3.5 Other participant's page lists kicked-off matches only; no pre-kickoff prediction shown
- [ ] 3.6 Kicked-off-but-unresulted match shows the other's revealed prediction, no result/points
- [ ] 3.7 `/history/<own-id>` redirects to `/history`; unknown UUID and malformed non-UUID id both show not-found state

### Phase 4: Tests (blindness + consistency + row logic)

#### Automated

- [ ] 4.1 Unit suite passes: `npm test`
- [ ] 4.2 Row-builder test passes: `npm test -- history`
- [ ] 4.3 DB/RLS suite passes with Supabase up: `npm test -- rls`
- [ ] 4.4 Type checking passes: `npm run lint`
- [ ] 4.5 Linting passes: `npm run lint`

#### Manual

- [ ] 4.6 Removing the `predictor_id` filter makes the blindness test fail (test has teeth)
