# Results, Scoring & Leaderboard (S-04, north star) — Implementation Plan

## Overview

Complete the north-star path: let the admin enter and correct a match result after kickoff, score every participant's prediction with the FR-018 rule (3/2/1/0), and rank all participants on a leaderboard (FR-020). Scoring is computed read-time in SQL so a result correction (FR-010) recomputes everything for free. Post-kickoff prediction visibility (FR-016) already ships from S-03 and is preserved unchanged.

## Current State Analysis

- **`matches`** (`supabase/migrations/20260602180000_tournament_and_matches.sql:41-49`) has no result columns. Its `matches_update` policy is `USING (public.is_admin() AND kickoff_time > now())` (`:103-107`) — the FR-008 pre-kickoff fixture-edit lock. It blocks *every* post-kickoff UPDATE on a match row, so result entry (post-kickoff by definition) cannot write to `matches` under the current policy.
- **`predictions`** (`supabase/migrations/20260604184657_predictions_with_blindness.sql:27-38`) holds `home_goals`/`away_goals` (smallint, 0–99), `UNIQUE (predictor_id, match_id)`. Its `predictions_select` policy `USING (predictor_id = auth.uid() OR public.match_is_kicked_off(match_id))` (`:78-81`) already delivers FR-015 (hide pre-kickoff) and FR-016 (reveal post-kickoff). No `is_admin()` branch — admin is blind pre-kickoff (FR-017).
- **`match_is_kicked_off(match_id)`** (`:60-71`): `STABLE SECURITY DEFINER`, returns `kickoff_time <= now()`. Reused for the result-write guard.
- **`profiles_public`** view (`supabase/migrations/20260528232000_identity_boundary.sql:64-68`, anon revoked in `20260601180000_revoke_profiles_public_anon.sql`) is the mandated non-admin identity read path; exposes `display_name`, authenticated-only. The leaderboard joins it.
- **Mutations are Astro Actions** (`src/actions/index.ts`), never `src/pages/api/*`. The closest analog is `predictions.upsert` (`:289-328`): fetch match → app pre-check → upsert → zero-row guard → `internalError()` on DB error.
- **Forms**: RHF + `zodResolver` + shared `src/lib/schemas/*` + `actions.*` + `window.location.reload()` (`src/components/predictions/PredictionForm.tsx:37-53`). `MatchList.tsx:44-68` shows past matches as "Locked".
- **Admin gating**: middleware `ADMIN_ROUTES = ["/admin"]` (`src/middleware.ts:11`); Actions re-check via `requireAdmin` (`src/actions/index.ts:56-61`). Leaderboard is all-authenticated.
- **Tests**: Vitest; live-DB suites `src/db/*.rls.test.ts` self-skip without env and run in the dedicated CI `rls` job (`.github/workflows/ci.yml:86-116`). No scoring/leaderboard/result code exists yet.
- **No `src/lib/services/` directory** exists; pure logic lives in `src/lib/*`. Scoring lives in SQL for this slice (no TS service needed).

### Key Discoveries:

- The post-kickoff UPDATE lock (`supabase/migrations/20260602180000_tournament_and_matches.sql:103-107`) is the reason results go in a **separate table**, not on `matches`.
- Because results are only writable post-kickoff, every prediction for a scored match is already world-visible — so an `security_invoker = true` leaderboard view sees all scored predictions for any caller while still respecting blindness for unscored (pre-kickoff) matches. This is the invariant that makes the leaderboard both complete and leak-free.
- Equal goal-difference implies equal outcome, so the FR-018 ladder collapses to: exact → same-difference → same-outcome → 0 (`context/foundation/prd.md:112`).
- S-02 lesson (impl-review F1): bind result-entry timezone/display to the DB `tournaments.time_zone`, never a hardcoded zone.

## Desired End State

The admin opens `/admin`, sees kickoff-passed matches with an inline score form, enters a result, and confirms; re-opening shows the saved result and lets them correct it. Every participant (including the admin) sees an updated `/leaderboard` ranking all participants by total points, tie-broken by exact-score count then alphabetically, reflecting the new/corrected result on next load. Pre-kickoff matches show no result form and their predictions stay blind. Verify: the FR-018 grid test, the tie-break test, and the result-write RLS test all pass in the CI `rls` job; manual entry → leaderboard update works end-to-end.

## What We're NOT Doing

- No result columns on `matches`; no stored points column on `predictions` (scoring is read-time SQL).
- No participant match-by-match history page (that is S-05) — only the leaderboard and the admin result surface.
- No "who has predicted" indicator, no real-time/live leaderboard updates (PRD Non-Goals; leaderboard updates on next page load).
- No change to the `predictions` blindness policy or `matches` fixture policies.
- No new service-role usage; no `.rpc()`-based mutation (the Action uses the session/admin SSR client + table writes under RLS).
- No result deletion path (correction is an upsert; FR-004 cascade on participant delete is S-06).
- No shadcn `table` dependency — the leaderboard uses a raw HTML table per the `src/pages/admin/participants.astro:55-77` precedent.

## Implementation Approach

DB-first, matching the codebase's "RLS is the source of truth, app checks are friendly mirrors" pattern. Phase 1 lands the entire data + scoring layer and proves it with DB tests. Phase 2 adds the admin write path as an Action. Phase 3 wires the admin UI. Phase 4 adds the read-only leaderboard page. Each phase is independently verifiable.

## Critical Implementation Details

- **FR-018 ordering (load-bearing contract — Phases 1 & 2's tests pin this).** The scoring function must evaluate in this exact order; equal difference is checked before equal outcome because equal difference subsumes outcome:

```sql
create function public.score_prediction(p_home int, p_away int, r_home int, r_away int)
  returns int language sql immutable
as $$
  select case
    when p_home = r_home and p_away = r_away then 3
    when (p_home - p_away) = (r_home - r_away) then 2
    when sign(p_home - p_away) = sign(r_home - r_away) then 1
    else 0
  end;
$$;
```

- **Leaderboard view must be `security_invoker = true`.** This is defense-in-depth: even if a result were ever wrongly written for a not-kicked-off match, the caller's blindness RLS on `predictions` would still hide unrevealed rows. Completeness relies on the post-kickoff-result invariant (Phase 1 RLS), not on a definer bypass.
- **Result-write guard reuses `match_is_kicked_off(match_id)`** — do not introduce a second time-source. The Action's app-layer pre-check mirrors it with `new Date(kickoff_time).getTime() <= Date.now()` purely for a friendly error.

---

## Phase 1: Data model & scoring (DB layer)

### Overview

One migration creates the result table, its RLS, the scoring function, the two views, and grants; regenerate DB types; add the DB-layer tests.

### Changes Required:

#### 1. Migration: results, scoring, leaderboard

**File**: `supabase/migrations/<timestamp>_results_scoring_leaderboard.sql` (create via `npm run db:migration:new results_scoring_leaderboard`)

**Intent**: Add post-kickoff result storage, the FR-018 scoring rule as SQL, and the per-prediction + leaderboard read views, with RLS/grants that preserve blindness and the FR-008 lock.

**Contract**:
- Table `public.match_results`: `id uuid pk default gen_random_uuid()`, `match_id uuid not null unique references public.matches(id) on delete cascade`, `home_score smallint not null check (home_score between 0 and 99)`, `away_score smallint not null check (away_score between 0 and 99)`, `created_at`/`updated_at timestamptz not null default now()`. `updated_at` trigger using existing `public.set_updated_at()`.
- `alter table public.match_results enable row level security;`
- Policies (`to authenticated`):
  - `match_results_select USING (true)` — results are public (they only exist post-kickoff).
  - `match_results_insert WITH CHECK (public.is_admin() AND public.match_is_kicked_off(match_id))`.
  - `match_results_update USING (public.is_admin() AND public.match_is_kicked_off(match_id)) WITH CHECK (public.is_admin() AND public.match_is_kicked_off(match_id))`.
  - No DELETE policy (correction is upsert).
- Function `public.score_prediction(p_home int, p_away int, r_home int, r_away int) returns int language sql immutable` — body per Critical Implementation Details. No table access → no security context needed.
- View `public.prediction_scores` `WITH (security_invoker = true)`: selects `predictor_id, match_id, home_goals, away_goals, home_score, away_score, public.score_prediction(home_goals, away_goals, home_score, away_score) as points` from `predictions p join match_results r on r.match_id = p.match_id`.
- View `public.leaderboard` `WITH (security_invoker = true)`: from `profiles_public pr left join prediction_scores s on s.predictor_id = pr.id`, group by `pr.id, pr.display_name`, select `pr.id as participant_id, pr.display_name, coalesce(sum(s.points),0) as total_points, count(*) filter (where s.points = 3) as exact_scores`, `order by total_points desc, exact_scores desc, lower(pr.display_name) asc`.
- `grant select on public.match_results, public.prediction_scores, public.leaderboard to authenticated;`
- Forward-only; do not edit applied migrations.

#### 2. Regenerate DB types

**File**: `src/db/database.types.ts`

**Intent**: Reflect the new table, function, and views so Actions/pages are typed.

**Contract**: Run `npm run db:reset` then `npm run db:types`; commit the regenerated file (ESLint/Prettier-ignored). `match_results` Row/Insert/Update, `score_prediction` function, and `prediction_scores`/`leaderboard` view rows must appear.

#### 3. DB-layer tests

**File**: `src/db/results-scoring.rls.test.ts` (new; mirror `src/db/predictions.rls.test.ts` harness — `describe.skipIf(!dbConfigured)`, service-role setup client + role-scoped clients)

**Intent**: Pin the FR-018 rule exhaustively, the tie-break ordering, and the result-write RLS policy.

**Contract**:
- **FR-018 grid (16 cases)**: one DB query selecting `public.score_prediction(...)` over a `VALUES` grid of (prediction, result) pairs covering exact / same-difference-nonexact / same-outcome-only / wrong-outcome / draw cases; assert each expected point value.
- **Tie-break**: seed ≥3 participants + a played match (result via service client), with predictions producing a points tie and an exact-score-count difference; assert `leaderboard` row order is total_points → exact_scores → `lower(display_name)`.
- **Result-write RLS**: admin (role client) upserts a result on a past-kickoff match → 1 row; participant attempts insert → 0 rows / denied; admin attempts insert on a future-kickoff match → 0 rows (the `match_is_kicked_off` guard); a participant `select` on `match_results` returns the row (public).
- **FR-019 / completeness**: a participant who did not predict the played match appears in `leaderboard` with `total_points = 0`.

#### 4. CI `rls` job already runs DB tests

**File**: `.github/workflows/ci.yml`

**Intent**: Ensure the new suite runs in CI.

**Contract**: The existing `rls` job runs `npm test -- rls` after `supabase start`; the new file matches the `rls` filter by name. Confirm no job edit is needed (filename contains `rls`).

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npm run db:reset`
- DB types regenerate without diff drift beyond the new objects: `npm run db:types`
- Type checking passes: `npm run lint` (strict-type-checked)
- Linting passes: `npm run lint`
- DB/RLS suite passes locally with Supabase up: `npm test -- rls`

#### Manual Verification:

- Inspecting the local DB shows `match_results`, `score_prediction`, `prediction_scores`, `leaderboard` with the expected grants.
- A hand-written `select * from leaderboard` returns all profiles with sensible totals after manually inserting a result.

---

## Phase 2: Result-entry backend (Action)

### Overview

Add the admin-only result upsert as an Astro Action with defense-in-depth, plus its shared zod schema.

### Changes Required:

#### 1. Result zod schema

**File**: `src/lib/schemas/result.ts` (new; mirror `src/lib/schemas/prediction.ts`)

**Intent**: Shared validation for the Action input and the React form.

**Contract**: `resultUpsertSchema = z.object({ matchId: z.string().uuid(), homeScore: <int 0–99>, awayScore: <int 0–99> })` and exported `ResultUpsertInput`. Match the integer-coercion style used by `predictionUpsertSchema`.

#### 2. `results.upsert` Action

**File**: `src/actions/index.ts`

**Intent**: Admin enters/corrects a result on a kicked-off match; everything else (scoring, leaderboard) follows from the views.

**Contract**: New `results` namespace with `upsert: defineAction({ accept: "json", input: resultUpsertSchema, handler })`. Handler: `requireAdmin(context.locals)` then `adminClient(context)`; fetch the match's `kickoff_time` (distinguish `NOT_FOUND` from lock per S-02 F5; surface `matchError` per S-03 fix); app pre-check `new Date(kickoff_time).getTime() <= Date.now()` else `FORBIDDEN` with a "not kicked off yet" message; `upsert` into `match_results` with `onConflict: "match_id"` and `.select("id")`; zero rows → `FORBIDDEN` (RLS lock); DB error → `internalError(error)`. Uses session/admin SSR client + RLS — never the service-role client.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Linting passes: `npm run lint`
- Existing Action tests still pass: `npm test`
- (If a guard unit test is added) admin-guard test passes: `npm test`

#### Manual Verification:

- Calling `actions.results.upsert` as a participant is rejected `UNAUTHORIZED` before any DB call.
- Upserting a result for a future-kickoff match returns the friendly "not kicked off" error.
- Upserting then re-upserting a different score updates the single `match_results` row.

---

## Phase 3: Admin result-entry UI

### Overview

Extend the `/admin` surface so kickoff-passed matches show an inline result form pre-filled with any saved result.

### Changes Required:

#### 1. Load results in `/admin` SSR

**File**: `src/pages/admin/index.astro`

**Intent**: Provide each match's current result (if any) to the list island.

**Contract**: Alongside the existing matches query, select from `match_results` for the tournament's matches and merge into the `matchRows` mapping as `result: { homeScore, awayScore } | null`. Keep the existing `isPast` computation and `formatInZone` using the DB `tournaments.time_zone` (S-02 F1).

#### 2. Inline result form in the match list

**File**: `src/components/admin/MatchList.tsx` and a new `src/components/admin/ResultForm.tsx` (clone of `src/components/predictions/PredictionForm.tsx`)

**Intent**: For past matches, replace the bare "Locked" label with a home/away score form that calls `actions.results.upsert`; future matches keep the existing edit/locked behavior.

**Contract**: `MatchList` row prop gains `result`. When `match.isPast`, render `<ResultForm matchId homeTeam awayTeam initial={result} />` (initial pre-fills for correction); else keep current fixture-edit affordance. `ResultForm`: RHF + `zodResolver(resultUpsertSchema)` + `actions.results.upsert` + `isInputError` field mapping + `window.location.reload()` on success, mirroring `PredictionForm.tsx:37-53`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Linting passes: `npm run lint`
- Production build passes: `npm run build`

#### Manual Verification:

- On `/admin`, a kickoff-passed match shows a score form; entering scores persists and the value survives reload.
- Editing a saved result updates it; a future-kickoff match shows no result form.
- A non-admin cannot reach `/admin` (middleware redirect).

---

## Phase 4: Leaderboard page

### Overview

A read-only `/leaderboard` page for all authenticated users, reading the `leaderboard` view, linked from the dashboard.

### Changes Required:

#### 1. Leaderboard page

**File**: `src/pages/leaderboard/index.astro` (new; follow `src/pages/predictions/index.astro` SSR pattern)

**Intent**: Render all participants ranked by the view's order, with an empty/"no results yet" state.

**Contract**: SSR `select participant_id, display_name, total_points, exact_scores from leaderboard` via the session client (RLS-respecting). Render a raw HTML table (rank, name, points; optionally exact-score count) using the `src/pages/admin/participants.astro:55-77` table pattern inside the `max-w-3xl` `Layout` shell. If every row is 0 / no results exist yet, show a friendly "No results entered yet — standings appear once the admin enters a result." hint. Back-link to `/dashboard`.

#### 2. Dashboard link

**File**: `src/pages/dashboard.astro`

**Intent**: Make the leaderboard reachable.

**Contract**: Add a `/leaderboard` link next to the existing "My predictions" link (`:17-24`), visible to all authenticated users.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Linting passes: `npm run lint`
- Production build passes: `npm run build`

#### Manual Verification:

- `/leaderboard` lists every participant (incl. admin); a non-predictor shows 0.
- After the admin enters a result (Phase 3), totals and order update on reload; correcting the result recomputes them.
- A tie is broken by exact-score count, then alphabetically.
- Post-kickoff predictions are visible to all (FR-016 unaffected); pre-kickoff predictions remain hidden.

---

## Testing Strategy

### Unit Tests:

- `resultUpsertSchema` bounds (0–99, integer, uuid) if a schema test is added (optional; mirror `participant.test.ts`).

### Integration / DB Tests (CI `rls` job):

- FR-018 16-case grid against `score_prediction`.
- Leaderboard tie-break ordering (total → exact-score count → alphabetical).
- Result-write RLS: admin post-kickoff allowed; participant denied; admin pre-kickoff denied; results publicly selectable.
- FR-019 completeness: non-predictor appears with 0.

### Manual Testing Steps:

1. As admin, enter a result on a past match via `/admin`; confirm it persists and `/leaderboard` updates.
2. Correct the result; confirm scores and order recompute.
3. As a participant, confirm `/leaderboard` shows all participants and the post-kickoff predictions are visible.
4. Confirm a future-kickoff match shows no result form and its predictions stay blind.

## Performance Considerations

Read-time scoring recomputes per leaderboard load; negligible at MVP scale (5–20 users, low QPS per PRD). The `predictions(match_id)` / `(predictor_id)` indexes and `match_results.match_id` unique index cover the joins. Revisit only if the pool grows far beyond MVP.

## Migration Notes

Single forward-only migration; no data backfill (no prior results exist). `match_results` cascades on `matches`/participant deletion, aligning with FR-004 (S-06). `npm run db:reset` + `npm run db:types` after applying; commit regenerated types.

## References

- Related research: `context/changes/results-scoring-leaderboard/research.md`
- Scoring rule + tie-break: `context/foundation/prd.md:112-116`
- Predictions blindness/visibility precedent: `supabase/migrations/20260604184657_predictions_with_blindness.sql:60-92`
- Fixture-edit lock (the blocker): `supabase/migrations/20260602180000_tournament_and_matches.sql:103-107`
- Action pattern: `src/actions/index.ts:289-328`
- Form pattern: `src/components/predictions/PredictionForm.tsx:37-53`
- CI `rls` job: `.github/workflows/ci.yml:86-116`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Data model & scoring (DB layer)

#### Automated

- [x] 1.1 Migration applies cleanly: `npm run db:reset` — a7029fc
- [x] 1.2 DB types regenerate without drift beyond new objects: `npm run db:types` — a7029fc
- [x] 1.3 Type checking passes: `npm run lint` — a7029fc
- [x] 1.4 Linting passes: `npm run lint` — a7029fc
- [x] 1.5 DB/RLS suite passes locally with Supabase up: `npm test -- rls` — a7029fc

#### Manual

- [x] 1.6 Local DB shows `match_results`, `score_prediction`, `prediction_scores`, `leaderboard` with expected grants — a7029fc
- [x] 1.7 `select * from leaderboard` returns all profiles with sensible totals after a manual result insert — a7029fc

### Phase 2: Result-entry backend (Action)

#### Automated

- [x] 2.1 Type checking passes: `npm run lint` — 364683d
- [x] 2.2 Linting passes: `npm run lint` — 364683d
- [x] 2.3 Existing Action tests still pass: `npm test` — 364683d
- [x] 2.4 Admin-guard test passes (if added): `npm test` — 364683d

#### Manual

- [x] 2.5 Participant call to `actions.results.upsert` rejected `UNAUTHORIZED` before any DB call — 364683d
- [ ] 2.6 Upsert on a future-kickoff match returns the friendly "not kicked off" error
- [ ] 2.7 Re-upsert updates the single `match_results` row

### Phase 3: Admin result-entry UI

#### Automated

- [x] 3.1 Type checking passes: `npm run lint`
- [x] 3.2 Linting passes: `npm run lint`
- [x] 3.3 Production build passes: `npm run build`

#### Manual

- [ ] 3.4 Past match on `/admin` shows a score form; entry persists across reload
- [ ] 3.5 Saved result is editable; future-kickoff match shows no result form
- [ ] 3.6 Non-admin is redirected away from `/admin`

### Phase 4: Leaderboard page

#### Automated

- [ ] 4.1 Type checking passes: `npm run lint`
- [ ] 4.2 Linting passes: `npm run lint`
- [ ] 4.3 Production build passes: `npm run build`

#### Manual

- [ ] 4.4 `/leaderboard` lists every participant (incl. admin); non-predictor shows 0
- [ ] 4.5 Totals/order update after a result entry and after a correction
- [ ] 4.6 Tie broken by exact-score count, then alphabetically
- [ ] 4.7 Post-kickoff predictions visible to all; pre-kickoff still hidden
