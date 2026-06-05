<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Scoring & Ranking Correctness Tests (Test-Plan Phase 1)

- **Plan**: context/changes/testing-scoring/plan.md
- **Scope**: Phases 1–2 of 2 (full plan)
- **Date**: 2026-06-05
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS (DB-live lane re-confirmed green — see F2) |

## Evidence verified

- Diff scope (`git diff b567669~1..HEAD`) matches the plan exactly: `package.json` + `package-lock.json` (test-only `pg` `^8.21.0` / `@types/pg` `^8.20.0` devDeps), extended `src/db/results-scoring.rls.test.ts`, new `src/lib/schemas/result.test.ts`, plus benign doc/manifest updates (`change.md`, `plan.md`, `test-plan.md`, `.cursor/.10x-cli-manifest.json`). No product code or SQL migration touched.
- Recompute test (G1, closes G6): dedicated `echo`/`recomputeMatchId` isolated from the `[alpha…delta]` standings filter; flips exact(3)→wrong(0); asserts before/after on both `prediction_scores.points` and `leaderboard.total_points`/`exact_scores` via the service client.
- Grid boundary cases (G3): 5 PRD-derived 0..99 cases appended to `SCORING_GRID`.
- Case-tie (G2/G4): `alice`/`Bob` seeded with identical predictions; asserted via raw `pg` read of the view's own order.
- Node-environment docblock present (`// @vitest-environment node`, line 1); `pg` connection opened in `beforeAll`, `end()` in `afterAll`.
- Phase 2 schema test mirrors `participant.test.ts`; covers valid, 0/99 boundaries, string coercion, negative, non-integer, >99, invalid matchId.
- `npm run lint` → 0 errors (19 pre-existing `no-console` warnings, untouched). `npx vitest run` → schema test 7/7 green; DB suite self-skips (29 skipped) without DB env.

## Findings

### F1 — leaderboardOrder helper diverges from the plan's SQL contract

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — informational, no fix needed
- **Dimension**: Plan Adherence
- **Location**: src/db/results-scoring.rls.test.ts:143-147
- **Detail**: Plan change #2 specified a parameterized helper with `where participant_id = any($1) order by total_points desc, exact_scores desc, lower(display_name) asc`. The implementation runs a bare `select participant_id from public.leaderboard` (no WHERE, no explicit ORDER BY) and reads the view's own ordering. This is a justified, arguably superior deviation: an explicit `order by lower(...)` in the test would be a tautology (passes even against a broken view); reading the view's own order is what actually proves the `lower(display_name)` tie-break (G4). Reasoning is documented in a thorough code comment (:124-142); the `aliceRank < bobRank` indexOf assertion is robust to the unfiltered global read.
- **Fix**: None required — accept as a documented, superior deviation.
- **Decision**: ACCEPTED — documented superior deviation; no change.

### F2 — DB-live + mutation criteria not re-executed in this review

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — informational
- **Dimension**: Success Criteria
- **Location**: plan.md:129-139 (criteria 1.3, 1.5, 1.6, 1.8–1.10)
- **Detail**: No local Supabase stack was running, so the rls-job criteria (DB suite green, pg handle closed) and the two manual mutation sanity checks were not independently re-run here. They are marked `[x]` in Progress against commit b567669, and the suite correctly self-skipped (29 skipped) when DB env is absent. Directly verified: lint clean, schema test green, DB suite self-skips. Trusting the Progress marks for the live-DB lane.
- **Fix**: Optional — re-run `npm test -- results-scoring.rls` against a live stack to independently confirm the rls lane before promoting it to a required gate (Phase 4).
- **Decision**: RESOLVED — re-ran against a live local stack (Node 22.14.0): `results-scoring.rls` 29/29 passed, exit 0, no open-handle warning. Independently confirms criteria 1.3, 1.5, 1.6. (Note: the active shell defaults to Node 20 via `.cursor-server`, which fails `@supabase/supabase-js`' native-WebSocket requirement; the suite must run under the repo-pinned Node 22.) The two manual mutation sanity checks (1.8, 1.9) were left on their existing Progress marks — re-running them requires mutating product SQL + `db reset`, out of scope for this review.
