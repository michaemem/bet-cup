---
date: 2026-06-04T22:32:23+02:00
researcher: mimazu
git_commit: 2b6c8ec244c836973d943caf0991fc099ec8c5a3
branch: feature/test-plan
repository: bet-cup
topic: "Phase 1 — Scoring & ranking correctness (Risks #2, #7): where scoring/ranking live, recompute path, and the cheapest test layer"
tags: [research, codebase, scoring, leaderboard, FR-018, FR-010, FR-020, testing, vitest]
status: complete
last_updated: 2026-06-04
last_updated_by: mimazu
---

# Research: Phase 1 — Scoring & ranking correctness (Risks #2, #7)

**Date**: 2026-06-04T22:32:23+02:00
**Researcher**: mimazu
**Git Commit**: 2b6c8ec244c836973d943caf0991fc099ec8c5a3
**Branch**: feature/test-plan
**Repository**: bet-cup

## Research Question

Ground test-plan Phase 1 ("Scoring & ranking correctness") in the live codebase: where does FR-018 scoring live (TS vs SQL), where does a result correction trigger recompute (FR-010), where are leaderboard totals + tie-break ranking computed (FR-020), and what is the cheapest test layer that gives real signal for Risk #2 and Risk #7 — written in-convention with the existing test infrastructure.

## Summary

**The feature under test does not exist yet.** Scoring (FR-018/FR-019), result entry + recompute (FR-009/FR-010), and the leaderboard/ranking (FR-020) are all part of roadmap slice **S-04 (`results-scoring-leaderboard`), which is still `proposed`** — not implemented in TypeScript or in SQL. Four independent searches (scoring, recompute, ranking, test-infra) each independently confirmed: no scoring function, no `points`/result columns, no recompute trigger/loop, no leaderboard query, no `ORDER BY`/`.sort()` for standings anywhere in `src/**` or `supabase/migrations/**`. The rule exists only as product spec (PRD FR-018/FR-019/FR-020 + Business Logic).

What this means for Phase 1:

- **There is no implementation-under-test to point a test at today.** A "prove the grid is correct" / "prove a correction re-scores" / "prove the tie-break order" suite cannot bind to a symbol or a DB object that does not exist.
- Phase 1 is therefore a **fork**: either (a) **TDD** — this change defines the pure scoring + ranking modules *and* their tests together (the roadmap itself nudges toward an exhaustive grid unit test), or (b) **sequence after S-04** — block Phase 1 until `results-scoring-leaderboard` lands, then write tests against the real implementation. This is a framing decision for `/10x-plan` (or `/10x-frame`), surfaced in Open Questions below.
- The **test infrastructure is ready and well-understood** regardless of which fork: pure unit tests (`src/lib/*.test.ts`, `happy-dom`, `@/*` alias, no DB) run in the default CI `ci` job; DB-level tests (`src/db/*.rls.test.ts`) self-skip via `describe.skipIf(!dbConfigured)` and run only in the `rls` CI job against a local Supabase stack. The roadmap's own open question — "Postgres view on read vs. materialized points column" — decides whether Phase 1 ends up unit (pure fn) or DB-level.

The cheapest layer that satisfies the test-plan's Risk-Response (§2) — an **exhaustive prediction×result grid with an independent oracle**, and a **case-insensitive total→exact-count→name ranking with genuine ties** — is a **pure TS unit test**, *provided S-04 exposes the logic as extractable functions* (`scorePrediction`, `rankLeaderboard`). If S-04 puts scoring/ranking in a Postgres view, the same grid must be exercised at the DB level instead.

## Detailed Findings

### Area 1 — FR-018 scoring (Risk #2, "points computed wrong")

- **Not implemented in TS or SQL.** No `computeScore`/`scorePrediction`/`goalDiff`/`outcome` logic in `src/**`; no scoring view/function/trigger/generated-column in `supabase/migrations/**`. `src/lib/services/` does not exist.
- The only "score"-named code is **UI display of predicted goals**, not awarded points — `src/components/predictions/PredictionList.tsx:20-28` (`LockedScore` renders `homeGoals – awayGoals`).
- Predictions are persisted with predicted goals only, no points — `src/actions/index.ts:310-321` (`predictions.upsert` writes `home_goals`/`away_goals`).
- **No result columns exist** to score against. `matches` has teams + kickoff only, with an explicit deferral comment — `supabase/migrations/20260602180000_tournament_and_matches.sql:15` ("No home_score/away_score columns here — results + scoring are S-04") and `:41-49` (table DDL).
- `predictions` has no points/result columns — `supabase/migrations/20260604184657_predictions_with_blindness.sql:24-38` (comment + DDL; `home_goals`/`away_goals` smallint, `CHECK 0..99`, `unique (predictor_id, match_id)`).
- **Input validation that DOES exist** (the only FR-018-adjacent code testable today): `predictionUpsertSchema` — `src/lib/schemas/prediction.ts:14-18` (`homeGoals`/`awayGoals`: `z.coerce.number().int().min(0).max(99)`), mirrored by the DB CHECK. **No zod schema for admin-entered match results** (`src/lib/schemas/match.ts` validates teams + kickoff only).
- Spec source of truth: PRD `context/foundation/prd.md:112-114` (FR-018/019/020) and `:127-129` (Business Logic narrative — output is 0..3 inclusive; the "2" branch requires correct goal difference **and** correct outcome).

### Area 2 — FR-010 result correction → recompute (Risk #2, "correction fails to recompute")

- **No result-entry or result-correction path exists.** No `enterResult`/`setResult`/`correctResult` action, no API route, no DB function/trigger. `matches.update` (`src/actions/index.ts:237-276`) edits **fixture metadata only** (teams + kickoff) and only before kickoff — it does not touch results.
- **No recompute mechanism of any kind**: no DB trigger on a results table, no action loop writing points, no on-read view. The only Postgres functions present are unrelated infra: `set_updated_at()`, `handle_new_user()`, `match_is_kicked_off()` (kickoff lock for prediction RLS), and the `profiles_public` view.
- The recompute **strategy is an explicitly open S-04 decision**, owned by `/10x-plan` — `context/foundation/roadmap.md:131` ("a Postgres view that computes points on read … vs. a materialized score column written when a result is entered/corrected"). This single decision determines:
  - whether recompute is **implicit** (on-read view → correcting the result row makes the next read correct, no job) or **explicit** (materialized column → every correction must overwrite per-`(predictor_id, match_id)` points, and a test must prove totals change, not just that the write returned 200);
  - whether Risk #2's "do not treat saved as recomputed" check is a **DB-level** assertion (re-query totals after a correction) or a **pure-fn** assertion (call the scorer with the corrected result).
- Existing post-kickoff behavior is **reveal, not scoring**: predictions become readable via RLS `predictor_id = auth.uid() OR match_is_kicked_off(match_id)` — not a points path.

### Area 3 — FR-020 leaderboard totals + ranking + tie-break (Risk #7)

- **Not implemented in TS or SQL.** No totals summation, no leaderboard page/view/RPC, and crucially **zero `ORDER BY` and zero `.sort(`** for standings anywhere in the repo.
- Existing orderings are unrelated: admin participant list by `created_at` — `src/pages/admin/participants.astro:25-29`; match lists by `kickoff_time` — `src/pages/predictions/index.astro:35` (same in `src/pages/admin/index.astro`).
- **None of the three FR-020 keys exist yet**: (1) total points DESC, (2) exact-score (3pt) count DESC, (3) name case-insensitive ASC. So the tie-break order, the case-insensitivity, and the determinism on genuine ties are all currently un-auditable — there is nothing to point a test at.
- Name tie-break target column is `profiles.display_name` (FR-020 "name"), **not** `username`. Non-admin leaderboard reads should source names from the `profiles_public` view — `supabase/migrations/20260528232000_identity_boundary.sql:64-68` (`select id, display_name, created_at, updated_at from public.profiles`).
- Spec: PRD `context/foundation/prd.md:114-115` (FR-020 + the 2026-05-28 decision: primary tie-break = exact-score count, final fallback = case-insensitive alphabetical).

### Area 4 — Test infrastructure (how Phase 1 must be written, in-convention)

- **Vitest config** — `vitest.config.ts:1-26`: `environment: "happy-dom"` (all tests, even pure-lib); `@/*` → `./src/*` regex alias; **no** `setupFiles`/`globalSetup`; **globals off** (every file imports `describe/it/expect` from `"vitest"`); default include/exclude. `npm test` = `vitest run` (`package.json:14`).
- **Unit pattern (canonical)** — `src/lib/time.test.ts:1-28`: co-located `*.test.ts` beside the module; import the unit from `@/lib/...`; one `describe` per exported fn; sentence-style `it` titles; local oracle helpers allowed above `describe`; no mocks/DB. `src/lib/bulk-parse.test.ts` is table-driven (good template for the FR-018 grid). → A pure scoring suite would be `src/lib/scoring.test.ts` (or similar) and would **run in the default CI `ci` job**.
- **DB/RLS pattern** — `src/db/predictions.rls.test.ts`: gated by `describe.skipIf(!dbConfigured)` where `dbConfigured = Boolean(SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY)` (`:33-39`); connects via `@supabase/supabase-js` (not raw `pg`) with anon (signed-in sessions) + service-role (seed/cleanup) clients (`:46-57`); `beforeAll` seeds via service role, `afterAll` cascades cleanup; requires `npx supabase start`. Self-skips in the default `ci` job; runs in the dedicated **`rls` job** (`.github/workflows/ci.yml:115-116` → `npm test -- rls`). → A scoring-in-Postgres suite would live here as `src/db/scoring.*.test.ts` with the same skip gate.
- **Action pattern** (Phase 3, not Phase 1) — `src/actions/participants.test.ts:42-67`: imports the real `server` from `@/actions/index` and calls `.handler(input, context)` directly; `astro:actions`/`astro:env/server`/`astro:middleware` are aliased to stubs in `test/stubs/` (`astro-actions.ts` makes `defineAction` an identity fn so `.handler` is reachable; `astro-env-server.ts` maps secrets onto `process.env`).
- **Coverage**: `@vitest/coverage-v8` installed (`package.json:59`) but **not wired** as a gate (no `coverage` block, no script, not in CI).

## Code References

- `src/lib/schemas/prediction.ts:14-18` — `predictionUpsertSchema` (only FR-018-adjacent validation that exists today)
- `src/actions/index.ts:310-321` — `predictions.upsert` (predicted goals only, no points)
- `src/actions/index.ts:237-276` — `matches.update` (fixture metadata only; NOT result entry)
- `supabase/migrations/20260602180000_tournament_and_matches.sql:15,41-49` — `matches` DDL; explicit "results + scoring are S-04" deferral
- `supabase/migrations/20260604184657_predictions_with_blindness.sql:24-38` — `predictions` DDL; "No result/points columns — that is S-04"
- `supabase/migrations/20260528232000_identity_boundary.sql:64-68` — `profiles_public` view (name source for leaderboard)
- `src/pages/admin/participants.astro:25-29` / `src/pages/predictions/index.astro:35` — the only orderings in the repo (created_at / kickoff_time; not standings)
- `vitest.config.ts:1-26` — env, alias, stubs
- `src/lib/time.test.ts:1-28`, `src/lib/bulk-parse.test.ts` — pure-unit reference (grid template)
- `src/db/predictions.rls.test.ts:33-57` — DB-test skip gate + client harness
- `src/actions/participants.test.ts:42-67` — action-handler invocation pattern
- `test/stubs/astro-actions.ts`, `test/stubs/astro-env-server.ts`, `test/stubs/astro-middleware.ts` — virtual-module stubs
- `.github/workflows/ci.yml:22,115-116` — `ci` (`npm test`) vs `rls` (`npm test -- rls`) jobs
- `context/foundation/prd.md:112-115,127-129` — FR-018/019/020 + Business Logic (the test oracle's spec source)
- `context/foundation/roadmap.md:122-134` (esp. `:131`) — S-04 `proposed`; the on-read-view vs materialized-column open decision

## Architecture Insights

- **Two-lane test architecture is already established and is the spine of this whole rollout**: pure logic → default `ci` job (fast, no infra); anything touching Postgres/RLS → `skipIf`-gated `rls` job against a local Supabase stack. Phase 1's layer choice is fully determined by where S-04 puts the logic.
- **The schema deliberately reserves scoring for S-04** (matching migration comments), so there is no accidental half-implementation to mistake for the real thing — the absence is intentional, not an oversight.
- **The test-plan's Risk-Response cells (§2) already pre-encode the oracle discipline** Phase 1 needs: "oracle copied from the implementation under test" and "happy-path single pair only" are named anti-patterns for #2; "a snapshot of one leaderboard with no actual ties exercised" is the named anti-pattern for #7. The independent-oracle, full-grid, genuine-ties requirements are non-negotiable design inputs for the plan.
- **Extract-for-testability is the right lever even if SQL aggregates**: the test-infra agent's recommendation — expose `rankLeaderboard(entries)` as a pure fn even when totals are SQL-summed — lets the tie-break order be unit-tested deterministically without Postgres. Worth carrying into the plan as a design constraint on S-04.

## Historical Context (from prior changes)

- `context/foundation/roadmap.md:122-134` — S-04 `results-scoring-leaderboard` is `proposed`; bundles FR-009/FR-010/FR-016/FR-018/FR-019/FR-020; carries the unresolved scoring-strategy question (`:131`) and references the resolved tie-break decision (#9).
- `context/archive/2026-06-01-tournament-and-matches/plan.md:77-80` — results/scoring explicitly out of scope for the matches slice (the source of the "S-04" deferral comments in the migrations).
- `context/foundation/lessons.md` — (1) benign-but-unplanned support files appear in feature diffs (relevant when Phase 1 adds vitest files / a new scoring module); (2) **secret-isolation criteria must target production reads, not raw `grep` across `src/`** — directly relevant to Phase 2, and a reminder for Phase 1 to phrase any "scoring lives in exactly one place" criterion against the real reader, not a substring match.

## Related Research

- `context/foundation/test-plan.md` §2 (Risk Map + Risk Response for #2, #7), §3 Phase 1, §6.1 (unit cookbook) — the strategy this research grounds.
- No prior `research.md` exists for scoring/leaderboard (S-04 has not been planned yet).

## Open Questions

1. **Framing fork (decide before planning):** Phase 1 targets a feature that isn't built. Options:
   - **(a) TDD within this change** — define `scorePrediction` + `rankLeaderboard` (pure fns) and write the grid/recompute/tie-break suites together; later wire them into S-04's result-entry path. Pro: unblocks Phase 1 now, locks the oracle before the implementation can bias it (directly serves the §2 "don't copy the oracle" guardrail). Con: this change starts authoring product logic, which overlaps S-04's scope.
   - **(b) Sequence after S-04** — implement `results-scoring-leaderboard` first, then write Phase 1 tests against the real symbols/DB objects. Pro: clean scope separation. Con: Phase 1 is blocked; the test-plan ordering rationale ("scoring has zero coverage, cheapest win, serves in-flight S-04") assumed the logic would exist to test.
   - Recommended next step: run `/10x-frame testing-scoring` to resolve this fork before `/10x-plan`, because the change's premise (test an existing implementation) no longer holds.
2. **Layer-determining S-04 decision** (`roadmap.md:131`): on-read Postgres view vs. materialized points column. This picks unit (pure fn, default `ci` job) vs. DB-level (`skipIf` + `rls` job) for Phase 1, and changes what "recompute on correction" even means (implicit re-read vs. explicit overwrite).
3. **Result input validation** (FR-009): there is no result zod schema yet. The negative/non-integer "Must challenge" inputs from the test-plan's #2 cell need a validation surface to test against — does it land as a `resultUpsertSchema` (parallel to `predictionUpsertSchema`) or a DB CHECK, or both?
4. **Name source for the tie-break**: confirm the leaderboard reads `display_name` via `profiles_public` (per F-01 boundary) rather than `profiles` directly, so the case-insensitive name tie-break is tested against the column users actually rank by.
