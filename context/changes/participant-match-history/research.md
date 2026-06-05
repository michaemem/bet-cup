---
date: 2026-06-05T10:03:01+02:00
researcher: mimazu
git_commit: 99af1cf30370b87e63fe6fc7149d8ae29ac32bc2
branch: feature/S-05_participant-match-history
repository: bet-cup
topic: "S-05 participant-match-history: participant reviews their own match-by-match history (FR-021) + drill into other participants' revealed (post-kickoff) history"
tags: [research, codebase, history, scoring, leaderboard, predictions, rls, blindness, astro]
status: complete
last_updated: 2026-06-05
last_updated_by: mimazu
---

# Research: S-05 participant-match-history

**Date**: 2026-06-05T10:03:01+02:00
**Researcher**: mimazu
**Git Commit**: 99af1cf30370b87e63fe6fc7149d8ae29ac32bc2
**Branch**: feature/S-05_participant-match-history
**Repository**: bet-cup

## Research Question

Ground the implementation of roadmap slice **S-05** (`context/foundation/roadmap.md:140-150`): a participant opens a "my history" view and sees, for every match where a result has been entered, their own prediction, the actual result, and the points they earned; matches without a result yet are listed but show no points; their running total matches the leaderboard total for them. PRD ref: **FR-021** (`context/foundation/prd.md:116`). Prerequisite **S-04** (results/scoring/leaderboard) is `done` and on `main`.

**Plus a user-requested extension:** a participant should also be able to view **other participants' match history** — their *revealed* (post-kickoff) prediction history only, **never** future/pre-kickoff predictions. Confirmed scope (user, 2026-06-05): own history is the **default** page; participants can **drill into any other participant's revealed history** (entry point: leaderboard names). This is to be treated as an **in-scope extension of S-05**, with a PRD/roadmap amendment noted (new/extended FR for cross-participant history).

## Summary

S-05 is a **read-only, UI-light slice** that sits almost entirely on top of S-04's shipped data layer — **no new migration is strictly required** for the core feature. The concrete state:

- **The scoring/result data layer already exists and is sufficient.** S-04 shipped `match_results`, the `score_prediction()` SQL function, and two `security_invoker = true` views — `prediction_scores` (per-prediction points) and `leaderboard` (aggregates) — all with `authenticated` SELECT grants (`supabase/migrations/20260605052647_results_scoring_leaderboard.sql`). No app code reads `prediction_scores` yet; S-05 is its first consumer.
- **The blindness boundary for cross-participant history is already DB-enforced — for free.** The `predictions_select` RLS policy returns a row only when `predictor_id = auth.uid() OR match_is_kicked_off(match_id)` (`supabase/migrations/20260604184657_predictions_with_blindness.sql:78-81`). So querying `predictions` (or `prediction_scores`) filtered to *another* participant's id returns **only their kicked-off (revealed) predictions** — pre-kickoff picks are invisible at the database layer, with **no `is_admin()` exemption**. The user's "no future predictions" requirement is satisfied by the existing RLS; the app does not need to (and must not rely solely on) filter for it.
- **There is one real shape decision for the "no result yet" rows.** `prediction_scores` INNER JOINs `match_results`, so it contains **only matches that have a result**. FR-021 also wants matches *without* a result listed (no points). Those rows must come from a separate `matches` (+ own `predictions`) query and be merged in page frontmatter — exactly the pattern `predictions/index.astro` already uses. This is the central `/10x-plan` modeling choice (merge in TS frontmatter vs. add a new history SQL view).
- **All UI patterns to clone already exist.** A new participant-facing route needs **no middleware change** (default-deny gate already covers it); just a new `src/pages/history/...astro` page (clone the leaderboard/predictions SSR shell) and a dashboard nav link. The leaderboard's raw `<table>` and the read-only `PredictionList` row layout are the two UI templates.
- **The consistency guardrail is checkable.** The roadmap requires the per-participant running total to equal that participant's `leaderboard.total_points`. Both derive from the same `prediction_scores`/`score_prediction` source, so they agree by construction — worth pinning with a test.

## Detailed Findings

### Data layer — what S-04 shipped (all live on `main`)

Migration `supabase/migrations/20260605052647_results_scoring_leaderboard.sql`:

- **`match_results`** (`:31-40`): `id`, `match_id uuid not null unique → matches(id) on delete cascade`, `home_score`/`away_score smallint` (CHECK 0–99), timestamps. RLS enabled `:54`.
- **`score_prediction(p_home, p_away, r_home, r_away) returns int`** (`:77-88`), `language sql immutable`: `3` exact → `2` same goal-difference → `1` same outcome (`sign`) → `0`. No `GRANT EXECUTE` (called only inside the views and in service-role tests).
- **`prediction_scores` view** (`:99-111`), `security_invoker = true`:

```sql
select p.predictor_id, p.match_id, p.home_goals, p.away_goals,
       r.home_score, r.away_score,
       public.score_prediction(p.home_goals, p.away_goals, r.home_score, r.away_score) as points
from public.predictions p
join public.match_results r on r.match_id = p.match_id;
```

- **`leaderboard` view** (`:121-132`), `security_invoker = true`: `profiles_public pr left join prediction_scores s on s.predictor_id = pr.id`, group by `pr.id, pr.display_name`, selects `participant_id, display_name, coalesce(sum(points),0) as total_points, count(*) filter (where points = 3) as exact_scores`, ordered `total_points desc, exact_scores desc, lower(display_name) asc` (FR-020 tie-break baked into the view).
- **Grants** (`:138-140`): `select` on all three objects to `authenticated`. No `anon`.

Generated types (committed): `src/db/database.types.ts` — `match_results` Row `:37-45`, `leaderboard` Row `:243-249`, `prediction_scores` Row `:252-261` (every column `| null` because it's a view), `score_prediction` fn `:323-326`.

### Blindness & cross-participant visibility (the key correctness finding)

- **`predictions_select`** (`supabase/migrations/20260604184657_predictions_with_blindness.sql:78-81`): `using (predictor_id = auth.uid() or public.match_is_kicked_off(match_id))`. No `is_admin()` branch → admin is blind pre-kickoff too (FR-017).
- **`match_is_kicked_off(p_match_id)`** (`:60-71`): `stable security definer`, returns `kickoff_time <= now()`, evaluated per-row at query time.
- **`prediction_scores` is `security_invoker = true`** → the caller's `predictions` RLS applies through the view.
- **Why others' pre-kickoff picks can never leak through `prediction_scores`:** a row needs a `match_results` join; `match_results` can only be written post-kickoff (`match_results_insert/update with check is_admin() AND match_is_kicked_off(match_id)`, `20260605052647...:61-70`). So every `prediction_scores` row is for a kicked-off match → world-visible by FR-016. Blindness is preserved **structurally**, not by view filtering.
- **Cross-participant history via `predictions` directly:** querying `predictions` (or `prediction_scores`) with `.eq("predictor_id", otherId)` returns only that participant's *kicked-off* rows — RLS drops their pre-kickoff picks automatically. **This is the exact boundary the user asked for, DB-enforced.**
- **`match_results_select using (true)`** (`:56-59`) and **`matches_select_all using (true)`** (`20260604184657...:105-110`) — both results and fixtures are readable by any authenticated user, so fixture labels + actual scores are freely joinable for any participant's history.

### The "matches without a result yet" gap

`prediction_scores` excludes matches with no result. FR-021 ("matches without a result yet are listed but show no points") therefore needs a second source:

- **Own history:** mirror `src/pages/predictions/index.astro:44-66` — load `matches` (ordered by kickoff), load own `predictions` (`.eq("predictor_id", userId)`), optionally load `match_results`, and merge by `match_id` in frontmatter into rows of `{ teams, kickoffLocal, isPast, prediction, result, points }`. `prediction_scores` can supply `points` for the resulted subset, or compute is unnecessary if you join `match_results` and reuse the points from `prediction_scores`.
- **Other participant's history:** load `predictions` filtered to that participant's id (RLS yields only revealed rows) + `match_results` + `matches`. Because RLS already restricts to kicked-off matches, an other-participant view is naturally "revealed-only"; pre-kickoff fixtures simply have no prediction row to show (show the fixture with "—" or omit, a `/10x-plan` UI call).

This merge-in-frontmatter vs. a dedicated `participant_history` SQL view is the main modeling fork for `/10x-plan`. A view would centralize the left-join (matches → predictions → results → points) and the blindness story; frontmatter merge matches the existing `predictions/index.astro` precedent and adds no migration.

### UI / page patterns to clone

- **Page shell & SSR client:** `src/pages/leaderboard/index.astro:5-11,43-83` and `src/pages/predictions/index.astro:5-12,71-86`. Session-scoped client via `createClient(Astro.request.headers, Astro.cookies)` from `@/lib/supabase` (RLS-respecting; **never** the service-role `supabase-admin`). `Layout` shell + `main.mx-auto.max-w-3xl.space-y-6.p-6` + header + "Back to dashboard" link.
- **DTO mapping & errors:** snake_case → camelCase in frontmatter; on query error `return new Response("Failed to load ...", { status: 500 })` (`leaderboard/index.astro:28-37`).
- **Tabular UI:** raw `<table class="w-full text-left text-sm">` with `tabular-nums` / `text-muted-foreground` (`leaderboard/index.astro:64-83`). **No shadcn `table`** primitive exists (`src/components/ui/`: button, calendar, form, input, label, popover only); AGENTS.md says add via `npx shadcn@latest add table` or reuse the raw-table precedent.
- **Read-only row list alternative:** `src/components/predictions/PredictionList.tsx:3-68` — exported `PredictionMatchRow` type + `<ul className="divide-border divide-y rounded-md border">` rows; clone as a read-only history list (no form). Empty state: `text-muted-foreground text-sm` paragraph.
- **Time handling:** display via `formatInZone(utc, tournament.time_zone)` from `src/lib/time.ts:97-108` (output `"YYYY-MM-DD HH:mm"` in the tournament IANA zone); `isPast = new Date(kickoff_time).getTime() <= Date.now()`. All conversion server-side; the island receives pre-formatted `kickoffLocal`. (S-02 impl-review lesson: bind to DB `tournaments.time_zone`, never a hardcoded zone.)
- **Nav entry:** `src/pages/dashboard.astro:17-29` — add a third participant link ("My history") in the same `flex justify-center gap-3` row as "My predictions"/"Leaderboard" (not admin-gated).
- **Drill-in entry point (per user's choice):** make leaderboard participant names link to `/history/<participant_id>` (or `?participant=`). `leaderboard/index.astro:73-79` renders `row.displayName` with `row.participantId` already in scope — wrap the name in an `<a>`.

### Routing / auth

- **Middleware** `src/middleware.ts:4-12,39-77`: default-deny via `PUBLIC_ROUTES` + `ADMIN_ROUTES` (note: AGENTS.md says `PROTECTED_ROUTES`, but live code is `PUBLIC_ROUTES` default-deny). A new `/history` route is **automatically auth-gated** and **not** admin-gated — no middleware edit needed. `context.locals.user` / `context.locals.profile` (roles via `loadProfile`) are set for every request.

### Testing conventions

- Vitest, two lanes: pure unit tests (default CI) and live-DB `src/db/*.rls.test.ts` suites that `describe.skipIf(!dbConfigured)` and run in the dedicated CI `rls` job after `supabase start` (`.github/workflows/ci.yml:86-116`). S-04's `src/db/results-scoring.rls.test.ts` is the closest precedent (service-role setup client + per-role signed-in clients).
- For S-05, the integrity-critical test is **cross-participant blindness**: assert that a participant reading another participant's history (via `predictions`/`prediction_scores` filtered to the other id) gets **zero** rows for a not-kicked-off match and the revealed rows for kicked-off ones. Plus a **consistency** test: a participant's summed history points equal their `leaderboard.total_points`.

## Code References

- `supabase/migrations/20260605052647_results_scoring_leaderboard.sql:31-40` — `match_results` table
- `supabase/migrations/20260605052647_results_scoring_leaderboard.sql:56-70` — `match_results` RLS (`select using (true)`; admin+kicked-off writes)
- `supabase/migrations/20260605052647_results_scoring_leaderboard.sql:77-88` — `score_prediction()` (FR-018)
- `supabase/migrations/20260605052647_results_scoring_leaderboard.sql:99-111` — `prediction_scores` view (security_invoker)
- `supabase/migrations/20260605052647_results_scoring_leaderboard.sql:121-132` — `leaderboard` view (FR-020 ordering)
- `supabase/migrations/20260604184657_predictions_with_blindness.sql:60-71` — `match_is_kicked_off()`
- `supabase/migrations/20260604184657_predictions_with_blindness.sql:78-92` — predictions RLS (FR-015/016, the blindness source of truth)
- `supabase/migrations/20260604184657_predictions_with_blindness.sql:105-110` — `matches_select_all using (true)`
- `src/db/database.types.ts:243-261` — generated `leaderboard` / `prediction_scores` Row types; `:37-45` `match_results`; `:323-326` `score_prediction`
- `src/pages/leaderboard/index.astro:5-83` — leaderboard SSR + raw table + empty states (clone shell + drill-in link)
- `src/pages/predictions/index.astro:5-86` — matches+own-predictions merge in frontmatter, `isPast`, `formatInZone`, island wiring
- `src/pages/dashboard.astro:17-47` — participant vs admin nav blocks (add "My history" link)
- `src/components/predictions/PredictionList.tsx:3-68` — read-only row-list template
- `src/lib/supabase.ts:8-27` — session-scoped SSR client (`createClient`)
- `src/lib/time.ts:97-108` — `formatInZone`
- `src/middleware.ts:4-12,39-77` — default-deny gate (no change needed for `/history`)
- `.github/workflows/ci.yml:86-116` — dedicated `rls` CI job
- `context/foundation/prd.md:116` — FR-021; `:104-107` FR-015/016/017 (blindness); `:112-115` FR-018/020
- `context/foundation/roadmap.md:140-150` — S-05 outcome/risk

## Architecture Insights

- **Visibility is time-driven, not result-driven (don't couple them).** A match can be kicked-off-and-visible with no result yet: predictions are shown, points pending. S-05's "listed but no points" state is exactly this. Keep the two queries (revealed predictions vs. scored predictions) conceptually separate.
- **Blindness for cross-participant history is a free DB property, not new app logic.** Reuse `predictions` RLS by filtering on the target `predictor_id`; do not add an app-layer `is_admin()`/owner check that could drift from the RLS. App-layer filtering is a friendly mirror, never the security boundary (house pattern: RLS authoritative).
- **`prediction_scores` is the canonical per-match points read; `leaderboard` is its aggregate.** Building history off the same view that feeds the leaderboard makes the running-total-equals-leaderboard-total invariant true by construction.
- **Service-role stays quarantined.** S-05 is pure session-client reads under RLS; it must not import `src/lib/supabase-admin.ts`.
- **No migration is required for the core slice.** If `/10x-plan` prefers a `participant_history` view for clarity, it's optional sugar, not a necessity — weigh against the existing zero-migration frontmatter-merge precedent.

## Historical Context (from prior changes)

- `context/archive/2026-06-04-results-scoring-leaderboard/plan.md:32-38` — S-04 explicitly scoped **out** the participant history page, deferring it to S-05; confirms read-time SQL scoring (a correction recomputes everything for free, so history points are always current).
- `context/archive/2026-06-04-results-scoring-leaderboard/research.md:132` — "visibility is time-driven, not result-driven" invariant (inherited here).
- `context/archive/2026-06-04-prediction-with-blindness/plan.md:48-49,80` — admin is NOT exempt from blindness; the FR-016 reveal lives in the single `predictions_select` policy (the basis for cross-participant revealed reads).
- `context/archive/2026-06-03-admin-creates-participants/reviews/impl-review.md:85` — `profiles_public` exposes `display_name` but **not** `username`; a history "viewing X's history" header should use `display_name`.
- `context/foundation/lessons.md:5-9` — declare benign support-file changes (e.g. a new shadcn `table`) in the plan to avoid false scope-creep flags. `:12-17` — phrase any secret/isolation grep checks against production reads.

## Related Research

- `context/archive/2026-06-04-results-scoring-leaderboard/research.md` — the scoring/leaderboard/RLS exploration this slice builds directly on.
- `context/archive/2026-06-04-prediction-with-blindness/research.md` — predictions blindness RLS (the cross-participant visibility boundary).

## PRD / Roadmap Amendment Note (cross-participant history)

FR-021 as written is **own** history only ("Participant can view **their own** match-by-match history…", `context/foundation/prd.md:116`). The agreed S-05 scope extends this so a participant can also view **other participants' revealed (post-kickoff) history**, never their pre-kickoff predictions — consistent with FR-016 and enforced by existing `predictions` RLS. **Action for `/10x-plan`:** record this as an extended/added functional requirement (e.g. FR-021 amended, or a new FR-021b: "Participant can view any other participant's match-by-match history for matches whose kickoff has passed; pre-kickoff predictions remain hidden per FR-015"), and reflect it in `context/foundation/prd.md` and the S-05 row/section of `context/foundation/roadmap.md`.

## Open Questions

1. **History data shape (the fork):** merge `matches` + `predictions` + `match_results`/`prediction_scores` in Astro frontmatter (zero-migration, mirrors `predictions/index.astro`) vs. a dedicated `participant_history` SQL view (centralizes the left-join + ordering). → owner: `/10x-plan`. Leans frontmatter-merge for MVP.
2. **Route & drill-in URL:** `/history` (own) + `/history/[participantId]` for others, vs. `/history?participant=<id>` query param. Leaderboard names link in. → owner: `/10x-plan`.
3. **Other-participant page completeness:** for another participant, do we list *all* fixtures (showing "—" for pre-kickoff, no prediction visible) or only matches where they have a revealed prediction/result? Pure UI/UX call; the DB returns only revealed rows regardless. → owner: `/10x-plan`.
4. **UI form factor:** raw `<table>` (leaderboard-style, good for prediction/result/points columns + running total) vs. read-only list island (PredictionList-style). → owner: `/10x-plan` or implementer.
5. **PRD/roadmap amendment wording** for cross-participant history (see amendment note above). → owner: `/10x-plan`.
