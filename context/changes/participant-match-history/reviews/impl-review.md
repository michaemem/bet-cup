<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Participant Match History (S-05)

- **Plan**: context/changes/participant-match-history/plan.md
- **Scope**: Phases 1–4 of 4 (full plan)
- **Date**: 2026-06-05
- **Verdict**: APPROVED
- **Findings**: 0 critical, 2 warnings, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Success criteria

- `npm run lint` — PASS (0 errors; 17 `no-console` warnings, pre-existing and shared with `predictions`/`leaderboard` pages).
- `npm test -- history` — PASS (7 passed; 4 RLS cases skipped, no local Supabase — `describe.skipIf(!dbConfigured)`).
- `npm run build` — PASS on Node 22 (initial local failure was only this shell's Node v20).
- `npm test -- rls` — not run locally (DB not configured); recorded as passing by the implementer at commit `7d2ab2a`.

## What's solid

- Blindness invariant holds: both pages use the session client only (no service-role); the `predictor_id` filter mirrors the RLS boundary rather than replacing it; the listing rule excludes another participant's pre-kickoff picks.
- `history.rls.test.ts` pins the blindness smoke and the history-total = leaderboard-total consistency check.
- Points read from `prediction_scores` everywhere (no TS recomputation of FR-018).
- All "What We're NOT Doing" guardrails respected (no migration/table/view, read-only, no username exposure, no RLS widening, no new shadcn dep, no in-page selector).

## Findings

### F1 — Transient profile-lookup errors masquerade as 404

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (Reliability)
- **Location**: src/pages/history/[participantId].astro:39-40
- **Detail**: `if (profileError || !profile) { notFound = true }` folds every `profiles_public` lookup failure into a 404 "Participant not found." The plan justified treating error-or-null as not-found to catch the 22P02 non-UUID case — but that case is now caught earlier by the `UUID_RE` short-circuit (L30). So the only errors reaching L39 for a valid-UUID id are genuine DB/transient failures, which now surface as 404 instead of 500. The very next read (tournament, L49-51) correctly returns 500 on error — inconsistent handling within the same file; a DB outage on this table looks like "no such user".
- **Fix**: Split the conditions — `!profile && !profileError` (and a UUID-shape miss) → 404; a non-null `profileError` → log + return 500, mirroring the tournamentError branch at L49-51.
- **Decision**: FIXED — profileError now logs + returns 500; missing row stays 404 (comment updated).

### F2 — loadHistory throws away the Supabase error detail

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Reliability/Observability)
- **Location**: src/lib/history.ts:135,144,149,155
- **Detail**: Each failed query throws `new Error("history: failed to load <rel>")` with no reference to the underlying PostgREST `{ error }` (code, message, hint). The pages catch and `console.error(..., error)`, but the real cause is gone — production logs show only the generic string. Sibling `predictions/index.astro` logs the actual Supabase error before each 500 (L24-25, L37-38).
- **Fix**: Throw with the cause attached, e.g. `throw new Error("history: failed to load matches", { cause: matchesError })` (or log the error inside loadHistory before throwing).
- **Decision**: FIXED — all four throws now attach `{ cause }`.

### F3 — Roadmap "GitHub Issues" table row not updated for FR-021b

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline (doc consistency)
- **Location**: context/foundation/roadmap.md:225
- **Detail**: Phase 1 updated the "At a glance" row, the S-05 section, and the Backlog Handoff row (all required by the contract). The separate "GitHub Issues" table row (~L225) still reads "Participant views their match-by-match history" with no FR-021b / cross-participant mention. Not in the plan's contract, so not a violation — a lingering doc inconsistency.
- **Fix**: Optionally extend that row's text + PRD refs to match the others.
- **Decision**: FIXED — broadened the S-05 title text in the GitHub Issues table (no PRD-refs column there). Note: this row's title now reads broader than the live GitHub issue #6 title; update issue #6 if exact parity matters.

### F4 — Own-history column header "Prediction" vs planned "your prediction"

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/pages/history/index.astro:68
- **Detail**: Plan listed the own-page columns as "match, kickoff, your prediction, result, points". The header renders "Prediction". Purely cosmetic. Note "your prediction" only fits the own page — the cross-participant page correctly uses "Prediction" (someone else's), so a shared table can't carry "your prediction" uniformly.
- **Fix**: Optional — rename the own-page header to "Your prediction"; leave the cross-participant header as "Prediction".
- **Decision**: FIXED — own-page header renamed to "Your prediction".

### F5 — HistoryRow.isPast computed but never rendered

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/lib/history.ts:21,111
- **Detail**: `isPast` is part of the plan's HistoryRow contract and is computed, but neither Astro template uses it. Dead-ish field (plan-compliant, just unused). Harmless.
- **Fix**: None now — use it for styling or drop it in a later follow-up.
- **Decision**: SKIPPED — kept as-is (in the planned contract; reserved for future styling use).

### F6 — Resulted-no-prediction shows "—", not a "no prediction" label

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/pages/history/index.astro:80 · src/pages/history/[participantId].astro:115
- **Detail**: The visibility matrix labels this case "no prediction"; result; 0 pts. Both pages render the prediction cell as "—" (points correctly 0). Already raised as F1 in the Phase-2 review and SKIPPED there; carried forward for completeness across both pages.
- **Fix**: Optional — render a muted "no prediction" when prediction is null but a result exists (one shared change benefits both pages).
- **Decision**: SKIPPED — consistent with the Phase-2 decision to keep "—".
