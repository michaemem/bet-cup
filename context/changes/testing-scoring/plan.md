# Scoring & Ranking Correctness Tests (Test-Plan Phase 1) Implementation Plan

## Overview

Close the six coverage gaps for **Risk #2** (points computed wrong, or a result correction fails to recompute affected scores) and **Risk #7** (leaderboard ranks participants wrongly — wrong totals or wrong tie-break order) at the cheapest layer that gives real signal. Scoring and ranking live entirely in SQL (S-04, migration `20260605052647_results_scoring_leaderboard.sql`), so the load-bearing tests are DB-level (`src/db/*.rls.test.ts`, executed in the CI `rls` job); the untrusted-input guardrail is a pure unit test (default `ci` job).

This phase **extends an existing suite that already covers the happy path** — it is gap-closing, not green-fielding.

## Current State Analysis

The feature shipped with tests. What already exists and passes:

- **FR-018 grid** — `src/db/results-scoring.rls.test.ts:65-86,192-201`: a 16-case `SCORING_GRID` asserted against `service.rpc("score_prediction", …)`. Expected values are hand-derived (an independent oracle), not computed from the function under test.
- **Leaderboard ordering + FR-019** — `:205-222`: seeds `a-alpha`/`b-bravo`/`c-charlie`/`d-delta`, reads the `leaderboard` view via supabase-js with **no `.order()`**, and asserts order `[alpha, bravo, charlie, delta]` plus totals/exact_scores (delta at 0/0).
- **`match_results` write RLS** — `:226-274`: admin upsert + correct on a kicked-off match; participant denied; admin denied on a future match; public read.
- **Pure assembly** — `src/lib/history.ts:73-119` (`buildHistoryRows`) is unit-tested without a DB (`src/lib/history.test.ts`); it never computes FR-018.
- **Action guard** — `src/actions/results.test.ts:46-60`: admin-only guard only (defers DB behavior to the RLS suite).

The gaps (from `research.md` §"Coverage Gaps"):

| Gap | What's missing | Risk |
|-----|----------------|------|
| **G1** | No before/after assertion that a result **correction recomputes** `prediction_scores`/`leaderboard`. The existing correction test (`:236-245`) checks only the `match_results` row, and corrects a match with **no predictions** — a broken recompute would still pass. | #2 |
| **G6** | `prediction_scores` is never read in the scoring suite (closed naturally by G1). | #2 |
| **G3** | Grid omits 0..99 boundary cases. | #2 |
| **G2** | Tie-break **case-insensitivity** is never exercised — `a-alpha`/`b-bravo` differ by first letter, so a raw `display_name` sort would pass identically to `lower()`. | #7 |
| **G4** | The tie-break test relies on the view's `ORDER BY` surviving a PostgREST `select()` with no explicit order — fragile. | #7 |
| **G5** | No `resultUpsertSchema` unit test for FR-009 negative / non-integer / out-of-range inputs (the #2 "Must challenge" cell). | #2 |

### Key Discoveries:

- **PostgREST cannot order by `lower(display_name)`** — supabase-js `.order("display_name")` is a raw byte sort (`"Bob"` (B=66) before `"alice"` (a=97)), the opposite of the view's `lower()` order. Proving G2/G4 deterministically therefore requires a **direct Postgres connection** (`research.md` Area 3, §"Architecture Insights").
- **`SUPABASE_DB_URL` is already available** wherever these tests run: it is the skip-gate sentinel (`results-scoring.rls.test.ts:35`), exported in the CI `rls` job (`.github/workflows/ci.yml:105-114`), and set in the file's local-run instructions (`:21-25`). No CI or local-setup change is needed to add a `pg` client.
- **No `pg` dependency exists** — the repo uses only `@supabase/supabase-js` (`package.json:35`). A test-only `pg` + `@types/pg` devDependency is the chosen path (vs. an rpc function, which would add a product migration purely to serve a test).
- **`display_name` is seed-controllable** via `user_metadata.display_name` (`createParticipant`, `:105-116`), so a case-only tie (`alice` vs `Bob`) is trivial to seed.
- **Isolation constraint**: the existing standings test filters to the four `a-alpha…d-delta` ids and asserts their exact totals. New scenarios (recompute, case-tie) **must use their own dedicated participants/matches** so they don't perturb those assertions.
- **Oracle discipline** (test-plan §2, `prd.md:113,129-133`): expected points/orderings are hand-derived from the PRD, never read back from `score_prediction`/the view under test. The existing grid already follows this.

## Desired End State

`npm test -- results-scoring.rls` (with a local Supabase stack up) passes a suite that additionally proves: (a) correcting a result re-scores every affected prediction and updates leaderboard totals; (b) the FR-018 grid holds at the 0..99 boundary; (c) the leaderboard's case-insensitive name tie-break is correct under a genuine case-only tie, asserted via an explicit `lower()` ordering. `npm test` (default `ci` job) additionally runs a pure `resultUpsertSchema` unit test that rejects negative/non-integer/out-of-range scores and accepts the 0 and 99 boundaries.

Verify: both lanes green locally and in CI (`ci` job runs the schema test; `rls` job runs the DB tests); a deliberate mutation of `score_prediction` or the `leaderboard` `ORDER BY` makes the new tests fail (manual sanity check).

## What We're NOT Doing

- No end-to-end predict→kickoff→result→leaderboard flow (Phase 4).
- No promotion of the `rls` suite to a **required** CI gate (Phase 4 / §5).
- No UI tests and no driving the correction through the `results.upsert` **action handler** (the action guard is already tested; the action mutation path is Phase 3).
- No changes to product code or SQL migrations — this is a test-only change (plus a test-only devDependency).
- No new shared test-client helper module — follow the existing per-file harness convention.

## Implementation Approach

Extend `src/db/results-scoring.rls.test.ts` in place (reusing its seed/cleanup harness) for the three DB-level gaps, adding a small `pg`-backed helper for the one assertion supabase-js cannot express. Add one new pure unit file for the schema gap. Keep all new scenarios isolated behind dedicated seed participants/matches so existing assertions are untouched.

## Phase 1: DB-level scoring, recompute & ranking

### Overview

Extend the live-DB suite to close G1, G6, G3, G2, G4. Runs in the CI `rls` job; self-skips in the default `ci` job.

### Changes Required:

#### 1. Test-only Postgres driver

**File**: `package.json`

**Intent**: Add a direct Postgres client so the case-insensitive tie-break can be read with an explicit `lower()` ordering that PostgREST cannot express. Test-only.

**Contract**: Add `pg` and `@types/pg` to `devDependencies` (latest stable via the package manager). No product dependency, no script changes.

#### 2. `pg`-backed explicit-ordered-read helper

**File**: `src/db/results-scoring.rls.test.ts`

**Intent**: Provide a helper that runs a single ordered SQL read against the `leaderboard` view using `process.env.SUPABASE_DB_URL`, so the name tie-break is asserted against the DB's real `lower()` order rather than relying on the view's implicit ordering surviving PostgREST (G4). Open the connection in `beforeAll` (or lazily) and close it in `afterAll` alongside the existing cleanup.

**Contract**: A function returning the ordered `participant_id` (and `display_name`) list for a given set of participant ids, executing:

```sql
select participant_id, display_name
from public.leaderboard
where participant_id = any($1)
order by total_points desc, exact_scores desc, lower(display_name) asc;
```

The `pg.Client`/`Pool` connects with `connectionString: process.env.SUPABASE_DB_URL` (the local stack uses no SSL). Guarded by the existing `dbConfigured` gate, so it never runs when the suite is skipped.

**Environment**: `vitest.config.ts` sets `environment: "happy-dom"` globally, and `pg` opens a raw TCP socket (node `net`/`tls`), which is not guaranteed to work under happy-dom. Pin this file to the node environment with a `// @vitest-environment node` docblock as its **first line** — the file uses no DOM APIs, so this is safe (alternatively, add a `src/db/**/*.rls.test.ts` → `node` environment override in `vitest.config.ts`).

#### 3. FR-018 grid — 0..99 boundary cases (G3)

**File**: `src/db/results-scoring.rls.test.ts`

**Intent**: Extend `SCORING_GRID` with upper-bound cases so the function is proven across the full `0..99` domain, keeping the hand-derived (PRD-sourced) oracle.

**Contract**: Append cases to `SCORING_GRID` (consumed unchanged by `it.each` at `:192`). Representative additions, expected values derived from `prd.md:113,129-133` (not from `score_prediction`): exact upper-bound `p=99-0, r=99-0 → 3`; exact upper-bound draw `p=99-99, r=99-99 → 3`; same-difference near bound `p=5-0, r=99-94 → 2`; same-outcome near bound `p=99-0, r=1-0 → 1`; wrong at bound `p=0-99, r=99-0 → 0`.

#### 4. Result correction → recompute (G1, closes G6)

**File**: `src/db/results-scoring.rls.test.ts`

**Intent**: Prove FR-010: after an admin corrects a result, `prediction_scores.points` and `leaderboard.total_points` reflect the corrected result on the next read — with **no** app-side recompute step. This is the core Risk #2 assertion; "row updated" / HTTP 200 is explicitly not sufficient.

**Contract**: In `beforeAll`, add **dedicated** seed data isolated from the existing standings assertion: a new past match (`recomputeMatchId`) and at least one dedicated participant (e.g. `echo`, not in the `[alpha…delta]` filter) with a known prediction. Both views are `security_invoker = true`, so **use the `service`-role client for all recompute reads** (it bypasses RLS, matches the seeding path, and removes per-row blindness as a variable from the assertion). Add a test that:
  1. seeds an initial result (service-role) and reads `prediction_scores` (filtered to the dedicated predictor/match) and `leaderboard` (filtered to the dedicated participant) via the `service` client — asserts the initial points/total computed by hand from FR-018;
  2. corrects the result via `admin.from("match_results").upsert({…}, { onConflict: "match_id" })` (the production correction shape, `:236-245`);
  3. re-reads `prediction_scores` and `leaderboard` via the `service` client and asserts the points/total **changed** to the new hand-derived expected values.

The corrected and initial results must map the prediction to **different** FR-018 points (e.g. exact→wrong) so a frozen/broken recompute is detectable.

#### 5. Case-insensitive name tie-break (G2, G4)

**File**: `src/db/results-scoring.rls.test.ts`

**Intent**: Prove FR-020's final tie-break is case-insensitive, under a genuine tie on the prior keys, asserted via the explicit `lower()` read (helper from change #2).

**Contract**: In `beforeAll`, seed two dedicated participants with **lower-case-vs-upper-case** names that invert under a raw byte sort — `alice` and `Bob` — each with identical predictions producing **equal `total_points` and equal `exact_scores`**. Add a test that calls the `pg` helper for `[aliceId, bobId]` and asserts the returned order is `[aliceId, bobId]` (`lower("alice") < lower("bob")`), i.e. the opposite of a raw `display_name` byte sort — which is what makes the assertion prove `lower()`.

**Scope note (G4)**: G4 is closed *for this new case-tie test* via the `pg` helper. The pre-existing standings order assertion at `results-scoring.rls.test.ts:215` is intentionally left on the view's implicit ordering — its totals/exact_scores assertions (`:217-221`) are order-independent, so its only exposure is the one `.toEqual([...])` order line, a low-risk pre-existing condition out of scope here.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Type/astro check passes: `npm run build` (or `npx astro check`)
- DB suite passes against a live local stack: `npx supabase start` then `SUPABASE_DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_ANON_KEY=<publishable> SUPABASE_SERVICE_ROLE_KEY=<secret> npm test -- results-scoring.rls`
- The suite still self-skips in the default lane: `npm test` reports `results-scoring.rls` skipped (no DB env)
- New tests are present and green: the recompute (G1), grid-boundary (G3), and case-tie (G2/G4) cases all pass; existing standings/RLS assertions remain unchanged and green
- `pg` connection is closed (no open-handle warning from Vitest after the run)
- The DB test file runs under the Vitest `node` environment (a `// @vitest-environment node` docblock is present so `pg`'s raw socket connects)

#### Manual Verification:

- Mutation sanity check: temporarily break `score_prediction` (e.g. swap the 2-pt and 1-pt branches) and confirm the grid + recompute tests fail; revert
- Mutation sanity check: temporarily change the `leaderboard` `ORDER BY` to raw `display_name` and confirm the case-tie test fails; revert
- Confirm the CI `rls` job runs the extended file (it already runs `npm test -- rls`)

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual mutation checks were successful before proceeding to the next phase.

---

## Phase 2: Result input validation unit test

### Overview

Close G5: prove `resultUpsertSchema` (FR-009) rejects the untrusted-input "Must challenge" cases. Pure unit test, runs in the default `ci` job (no DB).

### Changes Required:

#### 1. `resultUpsertSchema` unit test

**File**: `src/lib/schemas/result.test.ts`

**Intent**: Pin the FR-009 input contract independently of the DB CHECK and the action, mirroring the existing schema-test convention.

**Contract**: New file mirroring `src/lib/schemas/participant.test.ts` (one `describe("resultUpsertSchema")`, `safeParse(...).success` assertions). Cases: accepts a valid `{ matchId: <uuid>, homeScore, awayScore }`; accepts boundaries `0` and `99`; coerces numeric strings (`"3"` → `3`, mirroring `z.coerce.number()`); rejects negative; rejects non-integer (e.g. `1.5`); rejects `> 99`; rejects a missing/invalid `matchId`. Expected behavior derived from `src/lib/schemas/result.ts:13-17`.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Type/astro check passes: `npm run build` (or `npx astro check`)
- Default test lane includes and passes the new file: `npm test` runs `result.test.ts` green
- The file requires no DB and is not gated by `dbConfigured`

#### Manual Verification:

- Quick review that the rejected/accepted cases match FR-009 intent (negative, non-integer, >99 rejected; 0 and 99 accepted)

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before considering the change complete.

---

## Testing Strategy

### Unit Tests:

- `resultUpsertSchema`: reject negative / non-integer / >99; accept 0, 99, and coerced numeric strings; reject invalid `matchId` (Phase 2).

### Integration Tests (DB-level, `rls` job):

- FR-018 grid incl. 0..99 boundaries (Phase 1, change #3).
- Result correction recompute: before/after on `prediction_scores` and `leaderboard` (Phase 1, change #4).
- Case-insensitive name tie-break via explicit `lower()` ordering (Phase 1, change #5).

### Manual Testing Steps:

1. With the local stack up, run the DB lane and confirm the three new scenarios pass.
2. Mutation-test `score_prediction` and the `leaderboard` `ORDER BY` to confirm the new tests actually catch regressions, then revert.
3. Run the default lane and confirm the schema test passes and the DB suite self-skips.

## Performance Considerations

Negligible. One extra `pg` connection per DB-test run, opened once and closed in `afterAll`. A handful of additional seed rows.

## Migration Notes

None — no schema or data migrations. The only dependency change is a test-only `pg`/`@types/pg` devDependency.

## References

- Research: `context/changes/testing-scoring/research.md`
- Test strategy: `context/foundation/test-plan.md` §2 (Risk Response #2, #7), §3 Phase 1, §6.1/§6.2
- Implementation under test: `supabase/migrations/20260605052647_results_scoring_leaderboard.sql:77-88` (`score_prediction`), `:99-111` (`prediction_scores`), `:121-132` (`leaderboard`)
- Existing suite to extend: `src/db/results-scoring.rls.test.ts`
- Schema + convention: `src/lib/schemas/result.ts:13-17`, `src/lib/schemas/participant.test.ts`
- CI lanes: `.github/workflows/ci.yml:10-26` (`ci`), `:86-116` (`rls`)
- Oracle source: `context/foundation/prd.md:95,113-116,129-133`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: DB-level scoring, recompute & ranking

#### Automated

- [x] 1.1 Linting passes: `npm run lint` — b567669
- [x] 1.2 Type/astro check passes: `npm run build` — b567669
- [x] 1.3 DB suite passes against a live local stack: `npm test -- results-scoring.rls` — b567669
- [x] 1.4 Suite still self-skips in the default lane (`npm test`) — b567669
- [x] 1.5 Recompute (G1), grid-boundary (G3), and case-tie (G2/G4) tests present and green; existing assertions unchanged — b567669
- [x] 1.6 `pg` connection closed (no Vitest open-handle warning) — b567669
- [x] 1.7 DB test file runs under the Vitest `node` environment (`// @vitest-environment node` docblock present) — b567669

#### Manual

- [x] 1.8 Mutation check: breaking `score_prediction` fails the grid + recompute tests — b567669
- [x] 1.9 Mutation check: raw `display_name` ORDER BY fails the case-tie test — b567669
- [x] 1.10 CI `rls` job runs the extended file — b567669

### Phase 2: Result input validation unit test

#### Automated

- [x] 2.1 Linting passes: `npm run lint` — 8fa55eb
- [x] 2.2 Type/astro check passes: `npm run build` — 8fa55eb
- [x] 2.3 Default test lane runs `result.test.ts` green (`npm test`) — 8fa55eb
- [x] 2.4 File requires no DB / not gated by `dbConfigured` — 8fa55eb

#### Manual

- [x] 2.5 Review rejected/accepted cases match FR-009 intent — 8fa55eb
