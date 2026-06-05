# Scoring & Ranking Correctness Tests (Test-Plan Phase 1) — Plan Brief

> Full plan: `context/changes/testing-scoring/plan.md`
> Research: `context/changes/testing-scoring/research.md`

## What & Why

Pin the correctness of FR-018 scoring, FR-010 result-correction recompute, and FR-020 leaderboard ranking — the two highest-priority risks in the test plan (#2 points/recompute, #7 ranking/tie-break). The logic shipped in S-04 entirely as SQL and came with happy-path tests; this change closes the specific gaps that would let a real regression slip through.

## Starting Point

Scoring/ranking live in Postgres (migration `20260605052647`: `score_prediction()` fn + `prediction_scores`/`leaderboard` views, recompute is read-time). `src/db/results-scoring.rls.test.ts` already covers a 16-case grid, leaderboard ordering, and `match_results` write RLS. The holes: nothing proves a **correction actually re-scores**, the tie-break **case-insensitivity is never exercised**, and there's **no input-validation unit test** for FR-009.

## Desired End State

The DB suite additionally proves a corrected result re-scores every affected prediction and updates leaderboard totals; the FR-018 grid holds at the 0..99 boundary; and the case-insensitive name tie-break is correct under a genuine case-only tie, asserted via an explicit `lower()` read. A pure unit test rejects negative/non-integer/out-of-range result scores. Both CI lanes (`ci` for the unit test, `rls` for the DB tests) are green.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Test layer for #2/#7 | DB-level (`rls` job); unit for FR-009 | The logic is SQL, so DB tests are the cheapest real signal; input validation is pure | Research |
| How to drive the correction | Service/admin client upsert in the RLS suite | Matches existing style, isolates the read-time recompute invariant; action path is Phase 3 | Plan |
| Prove case-insensitive tie-break | Seed a real `alice`/`Bob` tie + explicit `lower()` ordered read | PostgREST can't `order by lower()`, and implicit view order is fragile (G4) | Plan |
| Ordered-read mechanism | Test-only `pg` client over `SUPABASE_DB_URL` | Honors determinism without an rpc product migration | Plan |
| `resultUpsertSchema` unit test | Include it (new `result.test.ts`) | Cheap, runs everywhere, satisfies #2's "Must challenge" cell | Plan |
| Test file organization | Extend `results-scoring.rls.test.ts` in place | Reuses the seed harness; keeps scoring DB coverage in one file | Plan |
| Scope boundary | DB tests + schema unit test only | No e2e, CI-gate promotion, or UI — those are Phase 4 | Plan |

## Scope

**In scope:**
- Correction → recompute before/after assertion on `prediction_scores` + `leaderboard` (G1, closes G6)
- FR-018 grid 0..99 boundary cases (G3)
- Case-only name tie-break via explicit `lower()` ordering (G2, G4)
- `resultUpsertSchema` unit test (G5)
- Test-only `pg` + `@types/pg` devDependency

**Out of scope:**
- End-to-end predict→result→leaderboard flow (Phase 4)
- Promoting `rls` to a required CI gate (Phase 4 / §5)
- Action-handler correction path + UI (Phase 3)
- Any product code or SQL migration change

## Architecture / Approach

Extend the existing live-DB suite (`src/db/results-scoring.rls.test.ts`), reusing its service/admin/participant client harness and seed/cleanup. New scenarios use **dedicated** seed participants/matches so the existing standings assertions stay untouched. One small `pg`-backed helper performs the single `order by … lower(display_name)` read that supabase-js cannot express, gated by the same `dbConfigured` check and closed in `afterAll`. The schema gap is a separate pure unit file in `src/lib/schemas/`, mirroring `participant.test.ts`.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. DB-level scoring, recompute & ranking | Recompute-on-correction, grid boundaries, case-insensitive tie-break; adds `pg` | Seed isolation (don't break existing standings assertion); closing the `pg` connection |
| 2. Result input validation unit test | `resultUpsertSchema` reject/accept cases (FR-009) | Trivial — keep oracle from the schema, not the DB CHECK |

**Prerequisites:** Local Supabase stack (`npx supabase start`) for Phase 1; `pg`/`@types/pg` installed.
**Estimated effort:** ~1 session across 2 phases.

## Open Risks & Assumptions

- A test-only `pg` devDependency + connection pattern is introduced (benign per `lessons.md`, but new to this repo).
- `SUPABASE_DB_URL` is assumed present whenever the DB lane runs — true today (skip-gate sentinel, CI `rls` export, local run instructions).
- New seed participants must stay outside the existing `[alpha…delta]` standings filter to avoid perturbing current assertions.

## Success Criteria (Summary)

- Correcting a result demonstrably changes `prediction_scores.points` and `leaderboard.total_points` (not just the `match_results` row).
- The leaderboard ranks `alice` before `Bob` on a genuine case-only tie (proving `lower()`), and the grid holds at 0..99.
- Invalid result inputs (negative, non-integer, >99) are rejected by `resultUpsertSchema`; both CI lanes pass.
