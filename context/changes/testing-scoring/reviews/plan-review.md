<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Scoring & Ranking Correctness Tests (Test-Plan Phase 1)

- **Plan**: context/changes/testing-scoring/plan.md
- **Mode**: Deep
- **Date**: 2026-06-05
- **Verdict**: SOUND
- **Findings**: 0 critical, 1 warning, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING |
| Plan Completeness | PASS |

## Grounding

5/5 paths ✓ (new `src/lib/schemas/result.test.ts` correctly absent — it is created by the plan); symbols ✓ (`score_prediction`, `leaderboard`, `security_invoker` present in migration `20260605052647`); `pg` correctly absent from `package.json`; CI `rls` job exports `SUPABASE_DB_URL` (`.github/workflows/ci.yml:114`) and runs `npm test -- rls` (`:116`); Progress↔Phase mapping mechanically correct; brief↔plan consistent.

Deep verification (sub-agent) confirmed: seed isolation is safe (standings test filters to the four ids before asserting order, `results-scoring.rls.test.ts:213-221`); `display_name` flows through `handle_new_user` (`20260604153800_participant_username.sql:47-57`) into `profiles_public`/`leaderboard`; `npm test -- rls` path-filters to `*.rls.test.ts` only, so `result.test.ts` correctly runs in the default `ci` job; no existing `pg` usage and no lint/tsconfig blocker; querying the `security_invoker` views as the `postgres` superuser returns correct rows for the seeded scored case (the plan's `WHERE participant_id = any($1)` filter handles the extra rows a superuser would see).

## Findings

### F1 — pg may not run under the global happy-dom test environment

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1, change #2 (pg-backed helper)
- **Detail**: `vitest.config.ts` sets `environment: "happy-dom"` globally, and every existing DB test reaches Postgres over HTTP via `@supabase/supabase-js` — never a raw TCP socket. The plan introduces `node-postgres` (raw net/tls) into `results-scoring.rls.test.ts` but says nothing about the test environment. Whether `pg` works under happy-dom is unproven in this repo (verification verdict: UNCERTAIN). If it doesn't, the case-tie test fails at connection time. The file uses no DOM APIs, so pinning it to the node environment is safe and removes the risk.
- **Fix**: In change #2, add `// @vitest-environment node` as the first line of `src/db/results-scoring.rls.test.ts` (or add a per-glob environment override for `src/db/**/*.rls.test.ts` in `vitest.config.ts`). Add a Phase-1 automated criterion that the file runs under the node environment.
- **Decision**: FIXED — added node-environment requirement to change #2 and Phase-1 automated criterion 1.7 (manual items renumbered 1.8–1.10).

### F2 — G4 left half-closed: existing standings order assertion still relies on implicit view ordering

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: End-State Alignment
- **Location**: Phase 1 (G4 scope) vs `src/db/results-scoring.rls.test.ts:215`
- **Detail**: The plan frames G4 ("fragile implicit ordering") and fixes it only for the new case-tie via the pg helper. But the pre-existing standings test at `:215` still asserts `.toEqual([alpha,bravo,charlie,delta])` from a PostgREST `select()` with no `.order()` — the exact fragility G4 names. The totals/exact_scores assertions (byId map, `:217-221`) are order-independent and fine; only the one order-equality line is exposed. Leaving it is defensible (pre-existing, low risk), but the plan claims to close G4.
- **Fix**: Either explicitly scope G4 to the case-tie in the plan text, or add a one-line note to harden `:215` via the same pg helper.
- **Decision**: FIXED — added a "Scope note (G4)" to change #5 clarifying G4 is closed for the new case-tie; the pre-existing `:215` line is left as-is (low risk, out of scope).

### F3 — Recompute test doesn't specify which client reads the views

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1, change #4 (steps 1 & 3)
- **Detail**: The before/after reads of `prediction_scores` / `leaderboard` don't name the client. Both views are `security_invoker = true`, so the reading client decides row visibility. Reading via the service-role client (bypasses RLS) is the simplest, matches the seeding path, and avoids per-row blindness confusion; reading via the participant client also works post-kickoff but adds a needless variable to a recompute assertion.
- **Fix**: Specify the service-role client for the recompute before/after reads (filtered by the dedicated predictor/participant id).
- **Decision**: FIXED — change #4 now specifies the `service`-role client for all recompute before/after reads.
