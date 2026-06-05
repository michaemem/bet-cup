---
date: 2026-06-05T18:38:27+02:00
researcher: mimazu
git_commit: 2b7891cd9dab7ab8d4dfbe18bb6b84e38c3f34bd
branch: feature/test-plan
repository: braveai-prj
topic: "Phase 1 — Scoring & ranking correctness (Risks #2, #7): where scoring/ranking live (now SQL), recompute path, existing test coverage, and the cheapest layer to close the gaps"
tags: [research, codebase, scoring, leaderboard, FR-018, FR-010, FR-020, testing, vitest, rls, supabase]
status: complete
last_updated: 2026-06-05
last_updated_by: mimazu
last_updated_note: "Full regeneration after S-04 (results-scoring-leaderboard) landed via rebase onto origin/main. The prior 'feature does not exist' conclusion is void. Feature is implemented in SQL (migration 20260605052647) and shipped WITH DB-level tests; this research re-grounds Phase 1 against the live implementation and its existing coverage gaps."
---

# Research: Phase 1 — Scoring & ranking correctness (Risks #2, #7)

**Date**: 2026-06-05T18:38:27+02:00
**Researcher**: mimazu
**Git Commit**: 2b7891cd9dab7ab8d4dfbe18bb6b84e38c3f34bd
**Branch**: feature/test-plan
**Repository**: braveai-prj

## Research Question

Ground test-plan Phase 1 ("Scoring & ranking correctness") in the **now-implemented** codebase: where does FR-018 scoring live (it is SQL), where does a result correction recompute (FR-010), where are leaderboard totals + tie-break ranking computed (FR-020), what is **already tested**, and what is the cheapest test layer that gives real signal for Risk #2 ("points computed wrong, or a correction fails to recompute") and Risk #7 ("leaderboard ranks wrongly — wrong totals or tie-break order"). Written in-convention with the existing test infrastructure.

> Supersedes the stale research at commit `2b6c8ec` (which concluded the feature did not exist). S-04 has since landed — anchor migration `supabase/migrations/20260605052647_results_scoring_leaderboard.sql`.

## Summary

**The feature exists and is entirely SQL — and it shipped with tests.** S-04 implements FR-018 scoring as a pure, immutable Postgres function, with read-time views for per-prediction points and the leaderboard. There is **no TypeScript scoring or ranking logic** — application code only *reads* the views. This decisively answers the stale research's two open forks:

- **Framing fork is moot.** There is a real implementation-under-test; this is no longer a TDD-vs-sequence decision.
- **Layer is determined: DB-level.** Because scoring and ranking are SQL, the cheapest layer that gives real signal is the `src/db/*.rls.test.ts` suite (self-skipping in the default `ci` job, executed in the dedicated `rls` CI job against a live local Supabase Postgres). The one genuinely pure-TS surface (`buildHistoryRows`) does **not** compute FR-018, so it is not where Risk #2/#7 live.

**Where the logic lives (single source of truth = SQL):**
- FR-018 pair scoring → `public.score_prediction(p_home,p_away,r_home,r_away)` — pure `immutable` SQL fn (`...20260605052647...sql:77-88`).
- Per-prediction points → `public.prediction_scores` view, `security_invoker = true`, INNER JOIN predictions↔match_results, calls `score_prediction` (`:99-111`).
- FR-010 recompute → **read-time, no materialization**. A correction is an upsert on `match_results`; the next read of the views re-scores "for free" (`:3-5`, `:486-487` action comment, `history.ts:11-14`).
- FR-020 leaderboard → `public.leaderboard` view: `coalesce(sum(points),0)`, LEFT JOIN from `profiles_public` (non-predictors at 0, FR-019), tie-break `total_points desc, exact_scores desc, lower(display_name) asc` (`:121-132`).

**What is already tested (the feature came with coverage):**
- `src/db/results-scoring.rls.test.ts` — 16-case FR-018 grid via `rpc('score_prediction')`; leaderboard tie-break order + FR-019 completeness; `match_results` write RLS (admin-only, post-kickoff-only, public read); an admin correction upsert.
- `src/db/history.rls.test.ts` — `prediction_scores` ↔ `leaderboard` consistency on a static seed.
- `src/lib/history.test.ts` — pure `buildHistoryRows` (assembles points it is *given*; assigns 0 for result-without-prediction; never recomputes FR-018).
- `src/actions/results.test.ts` — admin-guard only (no DB; defers post-kickoff + upsert to the RLS suite).

**The Phase 1 value is closing specific gaps, not green-fielding** (full gap list in §"Coverage Gaps"). The four highest-signal gaps:
1. **No before/after recompute assertion (the core of Risk #2).** The existing correction test (`results-scoring.rls.test.ts:236-245`) only checks the `match_results` row changed — and corrects a match with **no seeded predictions**, so even a broken recompute would pass. Nothing asserts `prediction_scores.points` / `leaderboard.total_points` *change* after a correction.
2. **Tie-break case-insensitivity unproven.** The seed uses `a-alpha`/`b-bravo` (already distinct first letters), so `lower()` is never exercised — a raw `display_name asc` would pass identically. A case-only tie (`"alice"` vs `"Bob"`) is needed to bind FR-020's case-insensitive fallback.
3. **Oracle independence + grid edges.** The 16-case grid is good but should derive expected values from the **PRD spec** (not the SQL body), and add 0..99 boundary cases and explicit `sign(0)` draw-vs-win cases.
4. **Fragile ordering reliance + no `resultUpsertSchema` test.** The leaderboard test relies on the view's `ORDER BY` surviving a PostgREST `select()` with no explicit `.order()`; and FR-009's negative/non-integer "Must challenge" inputs have no schema unit test.

## Detailed Findings

### Area 1 — FR-018 scoring (Risk #2, "points computed wrong")

**Implemented as a pure SQL function** — `supabase/migrations/20260605052647_results_scoring_leaderboard.sql:77-88`:

```77:88:supabase/migrations/20260605052647_results_scoring_leaderboard.sql
create function public.score_prediction(p_home int, p_away int, r_home int, r_away int)
  returns int
  language sql
  immutable
as $$
  select case
    when p_home = r_home and p_away = r_away then 3
    when (p_home - p_away) = (r_home - r_away) then 2
    when sign(p_home - p_away) = sign(r_home - r_away) then 1
    else 0
  end;
$$;
```

- **Branch order is load-bearing** (`:72-75`, `:90-91`): exact (3) → same goal-difference (2) → same outcome via `sign()` (1) → wrong (0). Same-difference is tested *before* same-outcome because, under the non-negative domain, equal difference subsumes equal outcome (e.g. `p=2-2, r=1-1` must score **2**, not fall through to **1**).
- **`sign()` encodes outcome**: `sign(0)=0` (draw), `>0`→1 (home win), `<0`→ -1 (away win).
- **Domain**: both tables enforce `0..99` (`predictions ...184657...sql:36-37`; `match_results ...052647...sql:38-39`). Within that domain the SQL 2-pt branch (diff only) is equivalent to FR-018's "diff **and** outcome".
- **Edge cases for an exhaustive grid**: 0-0 exact draw; draw vs win (`p=0-0, r=1-0` → 0, an explicit `sign(0)` case); negative goal-difference / away wins (`p=1-3, r=0-2` → 2); the branch-order trap (`p=2-2, r=1-1` → 2); 0..99 boundary (`p=99-0, r=99-0` → 3; `p=99-0, r=98-1` → 2; `p=99-99, r=99-99` → 3). The existing grid covers most categories but **omits 99-boundary and explicit `sign(0)` draw-vs-win** cases.

**No TypeScript scoring exists** (definitive): `src/lib/history.ts:11-14` states points are never computed in TS and are read from `prediction_scores` (`:151-155`). Searches for `scorePrediction`/`computeScore`/`goalDiff`/`outcome` in `src/**` return only the generated RPC type stub (`src/db/database.types.ts:323-326`). Zod mirrors DB bounds only, not scoring (`src/lib/schemas/result.ts:15-16`, `prediction.ts:16-17`).

**PRD oracle (spec is the source of truth, not the SQL body)**:
- FR-018 → `context/foundation/prd.md:113`; FR-019 → `:114`; FR-010 → `:95`.
- Business-Logic scoring narrative (primary oracle) → `:129-133`.
- US-02 acceptance (FR-018/019/010) → `:71-74`; NFR recompute-within-session → `:125`.
- **No behavioral discrepancy** between spec and SQL for valid (0..99) inputs.

### Area 2 — FR-010 result correction → recompute (Risk #2, "correction fails to recompute")

**Recompute is implicit and read-time — there is nothing to invalidate.** The `prediction_scores` view computes `points` in its SELECT (`:99-111`); correcting a result is an upsert on `match_results` (unique `match_id`, no DELETE path — `:27-29`, `:53`, `:66-70`), so the next read of `prediction_scores`/`leaderboard` reflects the corrected scores. Design intent stated at `:3-5`; action comment at `src/actions/index.ts:486-487`; PRD NFR at `prd.md:125`.

**Write path (how a test drives a correction)** — single production surface `results.upsert` (`src/actions/index.ts:477-531`):
- Uses the **session SSR admin client** `adminClient(context)` (anon key + caller cookies), not service-role (`:493`; `:74-80`; `src/lib/supabase.ts:8-26`).
- Admin gate via `requireAdmin` (`:61-64`, `:74-75`); app-level post-kickoff pre-check (`:499-510`); zero-row upsert → `FORBIDDEN`/`RESULT_NOT_KICKED_OFF` as RLS backstop (`:525-527`, error const `:30`).
- Write: `.from("match_results").upsert({ match_id, home_score, away_score }, { onConflict: "match_id" })` (`:512-522`) — correction is the *same* upsert.
- Input schema `resultUpsertSchema` (`src/lib/schemas/result.ts:14-16`): `matchId z.uuid()`, `homeScore`/`awayScore` `z.coerce.number().int().min(0).max(99)`. Mirrors `predictionUpsertSchema` (`prediction.ts:13-17`).
- UI: `/admin` (`src/pages/admin/index.astro:46-70`, `:105`) → `MatchList` (`src/components/admin/MatchList.tsx:77-85`) → `ResultForm` with `zodResolver(resultUpsertSchema)` calling `actions.results.upsert` (`src/components/admin/ResultForm.tsx:18-24,37-39,52`).

**RLS enforcement (mirror of the FR-008 fixture lock)** — `...052647...sql`:
- `match_results_select` `using (true)` for `authenticated` (`:56-59`) — results are public (they only exist post-kickoff, when predictions are already world-visible; the blindness invariant is documented at `:15-21`).
- `match_results_insert` / `match_results_update` require `is_admin() and match_is_kicked_off(match_id)` (`:61-70`). `match_is_kicked_off()` reused from S-03 (`...184657...sql:60-71`, evaluates `now()` per row → race-proof).

### Area 3 — FR-020 leaderboard totals + ranking + tie-break (Risk #7)

**Implemented as the `public.leaderboard` view** — `...052647...sql:121-132`:

```121:132:supabase/migrations/20260605052647_results_scoring_leaderboard.sql
create view public.leaderboard
  with (security_invoker = true)
as
  select
    pr.id as participant_id,
    pr.display_name,
    coalesce(sum(s.points), 0) as total_points,
    count(*) filter (where s.points = 3) as exact_scores
  from public.profiles_public pr
  left join public.prediction_scores s on s.predictor_id = pr.id
  group by pr.id, pr.display_name
  order by total_points desc, exact_scores desc, lower(pr.display_name) asc;
```

- **Totals + FR-019 completeness**: `LEFT JOIN` from `profiles_public` keeps every participant; `coalesce(sum(points),0)` → non-predictors at 0 (`:127-130`).
- **Tie-break chain** (`:132`): `total_points desc` → `exact_scores desc` (`count(*) filter (where points=3)`) → `lower(display_name) asc` (**case-insensitive**, confirmed — not raw `display_name`).
- **Name source**: `public.profiles_public` (`:129`), defined in `...20260528232000_identity_boundary.sql:64-68` (`select id, display_name, created_at, updated_at from public.profiles`; `security_invoker = false`; exposes no `legal_name`). FR-020 ranks by `display_name`, not `username`.
- **PRD oracle**: FR-020 → `prd.md:115`; tie-break decision (primary = exact-score count; final fallback = case-insensitive alphabetical) → `:116`. **SQL matches the spec on every key.**

**No TypeScript ranking exists.** The leaderboard page reads the view with **no `.order()`** and derives rank from array index (`src/pages/leaderboard/index.astro:23-27,74-76`). All other `.order()`/`.sort()` in the repo are unrelated (kickoff_time / created_at): `history.ts:81-83`, `admin/index.astro:40`, `admin/participants.astro:31`, `predictions/index.astro:35`.

**Ordering fragility (test-design note)**: an `ORDER BY` inside a view is not guaranteed to survive a re-query (caller `ORDER BY`, subquery, planner). The current UI and the tie-break test both *rely* on it surviving a plain PostgREST `select()`. PostgREST also cannot express `lower(display_name)` via `.order()`, so a **name-only** tie-break test must either issue raw SQL with `order by lower(display_name)` or compare the returned `participant_id` list. For robustness, Phase 1 tie-break assertions should not depend on implicit view ordering.

### Area 4 — Existing test coverage & infrastructure (how Phase 1 must be written)

**Two-lane architecture (unchanged, still the spine):**
- Pure logic → default `ci` job (`npm test`, `.github/workflows/ci.yml:10-26`).
- Postgres/RLS → self-skip in `ci`, run in the `rls` job which stands up Supabase and runs `npm test -- rls` (`ci.yml:86-116`, esp. `:101-116`).

**Vitest config** (`vitest.config.ts`): `environment: "happy-dom"` (`:11`); aliases `astro:middleware`/`astro:actions`/`astro:env/server` → `test/stubs/*` and `@/*` → `./src/*` (`:13-24`); no `setupFiles`/`globalSetup`; globals off. `npm test` = `vitest run` (`package.json:14`); DB helpers `db:start`/`db:reset` (`:16,20`).

**DB-test convention** (all `src/db/*.rls.test.ts`):
- Skip gate: `const dbConfigured = Boolean(process.env.SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY)` then `describe.skipIf(!dbConfigured)` (`results-scoring.rls.test.ts:35,88`). `SUPABASE_DB_URL` is only a "stack is up" sentinel — all access is via `@supabase/supabase-js`, not raw `pg`.
- Clients: service-role for seed/cleanup (bypasses RLS); signed-in anon clients per role (admin/participant) for RLS assertions (`:42-53,141,150-151`). Factories are inlined per file — **no shared helper module**.
- Seed/cleanup: unique IDs via `Date.now()` stamps; `beforeAll` seeds tournament→matches (admin) then results+predictions (service); `afterAll` deletes tournament (FK cascade) + `auth.admin.deleteUser` per user (`:140-188`).
- SQL fn call: `service.rpc("score_prediction", { p_home, p_away, r_home, r_away })` (`:192-201`). View reads: `participant.from("leaderboard").select(...)` with no explicit order (`:205-222`).

**What `src/db/results-scoring.rls.test.ts` already asserts:**
- FR-018 16-case grid (`SCORING_GRID` `:65-86`, run `:192-201`).
- Leaderboard order `[alpha, bravo, charlie, delta]` + totals/exact_scores + FR-019 (delta 0/0) (`:205-222`).
- `match_results` RLS: admin upsert on kicked-off match (`:226-234`); admin correction upsert (`:236-245`); participant insert denied (`:247-254`); admin insert on future match denied (`:256-263`); public read (`:265-274`).

**Pure-TS surface** — `src/lib/history.ts`: `buildHistoryRows` (`:73-119`) merges matches/predictions/results/scores, assigns `points = 0` for result-without-prediction, `null` for predicted-but-unresolved, sums `totalPoints`; **never computes FR-018** (`:11-14`). Unit-tested in `src/lib/history.test.ts:38-93` (no DB). `loadHistory` (`:127-171`) does the live reads.

**Action-guard surface** — `src/actions/results.test.ts:46-60`: non-admin/null-profile → `UNAUTHORIZED`; explicitly defers post-kickoff + upsert to the RLS suite (`:9-10`). No DB.

## Coverage Gaps (the Phase 1 work)

| # | Gap | Risk | Evidence |
|---|-----|------|----------|
| G1 | **No before/after recompute assertion.** The correction test checks only the `match_results` row, and corrects a match with no seeded predictions — a broken recompute would still pass. | #2 (FR-010) | `results-scoring.rls.test.ts:236-245`; correction target has no predictions (seed `:169-182`) |
| G2 | **Tie-break case-insensitivity unproven.** Seed names `a-alpha`/`b-bravo` differ by first letter, so `lower()` is never exercised; a case-only tie (`"alice"` vs `"Bob"`) is missing. | #7 (FR-020) | `:143-144,205-222`; view `:132` |
| G3 | **Oracle independence + grid edges.** Expected points should be derived from PRD (`prd.md:113,129-133`), not the SQL body; add 0..99 boundary and explicit `sign(0)` draw-vs-win cases. | #2 | grid `:65-86` |
| G4 | **Implicit ordering reliance.** Tie-break test depends on the view `ORDER BY` surviving a PostgREST `select()` with no `.order()`. | #7 | `:205-215`; `leaderboard/index.astro:23-27` |
| G5 | **No `resultUpsertSchema` unit test** for FR-009 negative/non-integer "Must challenge" inputs. | #2 | `src/lib/schemas/result.ts:14-16`; no `result.test.ts` (cf. `participant.test.ts`) |
| G6 | **`prediction_scores` not read in the scoring suite** (consistency lives only in `history.rls.test.ts` on a static seed). | #2 | `history.rls.test.ts:167-183` |

## Code References

- `supabase/migrations/20260605052647_results_scoring_leaderboard.sql:77-88` — `score_prediction()` FR-018 SQL fn (Risk #2 oracle target)
- `...052647...sql:99-111` — `prediction_scores` view (read-time recompute; `security_invoker`)
- `...052647...sql:121-132` — `leaderboard` view (totals, FR-019 LEFT JOIN, FR-020 tie-break)
- `...052647...sql:31-40,56-70` — `match_results` DDL + write RLS (admin-only, post-kickoff-only)
- `supabase/migrations/20260528232000_identity_boundary.sql:64-68` — `profiles_public` (name source, `display_name`)
- `supabase/migrations/20260604184657_predictions_with_blindness.sql:36-37,60-71` — predictions 0..99 CHECK; `match_is_kicked_off()`
- `src/actions/index.ts:477-531` — `results.upsert` (the result entry/correction path)
- `src/lib/schemas/result.ts:14-16` — `resultUpsertSchema` (FR-009 validation)
- `src/lib/history.ts:11-14,73-119,151-155` — points read from view; pure `buildHistoryRows`; no TS scoring
- `src/db/results-scoring.rls.test.ts:35,65-86,88,192-201,205-222,224-274` — skip gate, grid, fn call, tie-break, RLS
- `src/db/history.rls.test.ts:152-183` — `prediction_scores`↔`leaderboard` consistency (static)
- `src/lib/history.test.ts:38-93` — pure `buildHistoryRows` unit tests
- `src/actions/results.test.ts:9-10,46-60` — admin-guard only; defers DB to RLS suite
- `vitest.config.ts:11,13-24` / `.github/workflows/ci.yml:10-26,86-116` — env/alias; `ci` vs `rls` jobs
- `context/foundation/prd.md:95,113-116,125,129-133` — FR-010/018/019/020 + Business-Logic oracle

## Architecture Insights

- **Scoring is single-sourced in SQL; the recompute story is "nothing to invalidate."** Read-time views mean FR-010 correctness reduces to "the views recompute on read" — best proven by a before/after DB assertion, not by trusting an HTTP 200 or a row-level write (this is exactly the §2 anti-pattern "saved ≠ recomputed").
- **The layer choice is fully resolved to DB-level for Risk #2/#7.** The stale research's unit-vs-DB fork hinged on "on-read view vs materialized column"; the on-read view won, so the cheapest real-signal layer is `src/db/*.rls.test.ts` (rls job). The pure-TS `buildHistoryRows` deliberately *doesn't* score, so unit tests there cannot cover FR-018/FR-020.
- **The feature shipping with tests changes Phase 1 from authorship to gap-closing.** The test-plan's §2 anti-patterns are concrete here: G1 (don't stop at "row updated"), G2 (don't assert a tie-break that never ties), G3 (don't copy the oracle from the impl), G4 (don't snapshot an order you didn't pin).
- **Oracle discipline must be explicit.** Existing grid expectations sit beside the SQL they validate; Phase 1 should re-derive them from `prd.md:113,129-133` so the test cannot drift with the implementation.
- **PostgREST cannot express `lower(display_name)`** — the case-insensitive name tie-break (G2/G4) needs raw SQL ordering or a `participant_id`-list comparison, a real constraint on how the Phase 1 test is written.

## Historical Context (from prior changes)

- `context/changes/testing-scoring/research.md` (this file, prior version @ `2b6c8ec`) — concluded "feature does not exist"; now void. The two open forks it raised (TDD-vs-sequence; unit-vs-DB layer) are both resolved by S-04 landing as on-read SQL views.
- `context/foundation/roadmap.md` — S-04 `results-scoring-leaderboard` carried the "on-read view vs materialized column" decision; the migration shows **on-read view** was chosen (`...052647...sql:3-5`).
- `context/archive/2026-06-01-tournament-and-matches/plan.md` — results/scoring explicitly deferred to S-04 (source of the migration deferral comments).
- `context/foundation/lessons.md` — (1) benign-but-unplanned support files appear in feature diffs (Phase 1 will add/extend `*.test.ts`); (2) isolation criteria must target production reads, not raw `grep` across `src/` — relevant if any Phase 1 criterion asserts "scoring lives in one place" (it does: the SQL fn).

## Related Research

- `context/foundation/test-plan.md` §2 (Risk Map + Risk-Response for #2, #7), §3 Phase 1, §6.1/§6.2 (unit + RLS cookbooks) — the strategy this research grounds.
- `context/changes/testing-scoring/change.md` — Phase 1 change identity and risk-response intent.

## Open Questions

1. **Drive corrections via the action or via the client?** The recompute (G1) can be exercised either by calling the `results.upsert` handler end-to-end (admin `locals` + cookies, as in `participants.test.ts`) or by a service/admin client upsert in the RLS suite. The latter matches the existing `results-scoring.rls.test.ts` style and is the lower-cost path; the former additionally covers the action's post-kickoff pre-check. Decide in `/10x-plan` (likely: RLS-suite upsert for the recompute assertion; keep the action guard in the existing `results.test.ts`).
2. **Where does the `resultUpsertSchema` test live (G5)?** Pure unit (`src/lib/schemas/result.test.ts`, default `ci` job) parallel to `participant.test.ts` — confirm naming/placement in the plan.
3. **How to pin the name tie-break order deterministically (G2/G4)** given PostgREST's `lower()` limitation: raw SQL via a service-role `rpc`/query, or assert the returned `participant_id` ordering for a constructed case-only tie. Plan should pick one and document it in the §6.2 cookbook.
4. **Scope boundary with Phase 4.** A full predict→kickoff→result→leaderboard e2e is Phase 4; Phase 1 should stop at DB-level recompute/ranking assertions and not pull in the action/UI flow beyond what G1/G5 require.
