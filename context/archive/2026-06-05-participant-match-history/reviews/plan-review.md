<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Participant Match History (S-05)

- **Plan**: context/changes/participant-match-history/plan.md
- **Mode**: Deep
- **Date**: 2026-06-05
- **Verdict**: REVISE → SOUND (after triage; all 4 findings fixed 2026-06-05)
- **Findings**: 0 critical, 2 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING → PASS (F2 fixed) |
| Plan Completeness | WARNING → PASS (F1, F4 fixed) |

## Grounding

7/7 paths exist (prd.md, roadmap.md, ci.yml, supabase.ts, time.ts, dashboard.astro, leaderboard/index.astro; `src/pages/history` is new as planned). Symbols verified: `formatInZone` (time.ts), `prediction_scores`/`leaderboard`/`profiles_public` (database.types.ts + migration), `predictions_select` RLS (owner-OR-post-kickoff, no admin branch). brief↔plan consistent. Progress↔Phase mechanical contract holds: one `## Progress`, all 4 phases mirrored, every Success Criteria bullet has a matching checkbox. `docs/reference/contract-surfaces.md` absent (convention skipped).

## Findings

### F1 — loadHistory error propagation is undefined

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real contract gap; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 2 §1 (loadHistory) ↔ Phase 2 §2 / Phase 3 §1 (pages)
- **Detail**: The page contracts say "on any query error return new Response(..., { status: 500 })", but loadHistory's contract only says it "runs the four session-client queries and returns buildHistoryRows(...)". It never specifies how a query error reaches the caller — loadHistory returns a HistorySummary, not an error, so the page has nothing to branch on. The sibling pattern in predictions/index.astro checks `{ error }` after each of its reads and returns 500; collapsing the reads into loadHistory drops that channel unless the contract restores it.
- **Fix**: Specify loadHistory's error behavior — either it throws on the first query error (page wraps in try/catch → 500) or returns a discriminated result (`{ summary } | { error }`). State which, so the 500 path in both pages is actually reachable.
- **Decision**: FIXED — loadHistory now throws on the first query error; both `/history` and `/history/[participantId]` wrap the call in try/catch → 500.

### F2 — Malformed (non-UUID) participantId hits the error path, not the specified not-found state

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 3 §1, vs. Success Criteria 3.7
- **Detail**: The lookup is `profiles_public.eq("id", participantId).maybeSingle()`, and the contract handles only "absent → 404". But `id` is a uuid column: a non-UUID path like `/history/abc` makes Postgres raise `invalid input syntax for type uuid` (22P02) — that is `error`, not `data: null`. So the documented not-found branch never fires for the most likely "invalid id" input, yet manual criterion 3.7 asserts "an invalid id shows the not-found state." Contract vs. criterion mismatch.
- **Fix**: Treat a lookup that yields no usable row — whether `data: null` OR a 22P02/error — as the not-found (404) state. Optionally validate the UUID shape before querying. Make criterion 3.7 explicitly exercise a non-UUID id.
- **Decision**: FIXED — Phase 3 §1 now treats null-or-error as not-found (with optional UUID-shape short-circuit); criterion 3.7 + Progress 3.7 now exercise a malformed non-UUID id.

### F3 — history.rls.test.ts partially overlaps predictions.rls.test.ts

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Lean Execution
- **Location**: Phase 4 §2
- **Detail**: The blindness re-assertion duplicates ground already held by predictions.rls.test.ts. The plan acknowledges this and scopes the new test as "complementary." Its genuinely new value is the total-consistency assertion (sum(prediction_scores.points where predictor=B) == leaderboard.total_points for B) — the roadmap's named top risk for S-05. Keep the consistency assertion as the centerpiece and keep the blindness check thin (history read-path smoke, not a re-proof) so the harness stays lean.
- **Fix**: Frame the new test around the consistency invariant; reduce the blindness portion to a single history-read-path smoke assertion rather than re-proving the predictions policy.
- **Decision**: FIXED — Phase 4 §2 now leads with the consistency assertion as centerpiece and thins blindness to a single history-read-path smoke check.

### F4 — Roadmap line-number references are stale

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §2
- **Detail**: Phase 1 cites roadmap "At a glance (:41)", "S-05 section (:140-150)", "Backlog Handoff row (:186)". Actual: S-05 index row is line 37, the `### S-05` section is 136-146, the Backlog Handoff S-05 row is 182. The headings resolve unambiguously, so this is cosmetic — but the implementer should target headings, not line numbers.
- **Fix**: Replace the line-number anchors with heading anchors ("At a glance" table row, `### S-05` section, Backlog Handoff S-05 row).
- **Decision**: FIXED — Phase 1 §2 now targets heading anchors instead of line numbers.
