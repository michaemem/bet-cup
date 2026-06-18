<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Kickoff-lock & action-layer mutation tests (test-plan Phase 3)

- **Plan**: context/changes/testing-kickoff-lock-actions/plan.md
- **Scope**: Full plan (Phase 1 + 2 of 2)
- **Date**: 2026-06-18
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Automated criteria re-confirmed this session:
- `npm run lint` → 0 errors
- `npm test` (no DB) → 79 passed, live lanes self-skip
- `npm test -- rls` (live local Supabase, Node 22.14.0) → 57 passed (predictions.rls now 19, incl. the new write-flip)

## Findings

### F1 — Docblock/§6.6 over-attribute FORBIDDEN to the RLS zero-row

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/actions/predictions.test.ts:14-16, 254-264; context/foundation/test-plan.md §6.6 (Phase 3 entry)
- **Detail**: The prose says post-kickoff create/edit returns FORBIDDEN via "the RLS zero-row lock". For the seeded matches (kickoff 1h in the past), the app-layer `Date.now()` pre-check (src/actions/index.ts:520-522) fires FIRST and throws FORBIDDEN; the RLS zero-row guard (index.ts:540) is the race-proof backstop that these cases don't actually reach. The assertions are still correct (both branches yield code FORBIDDEN), and the RLS write-lock IS proven by the Phase 2 DB write-flip case + manual step 1.5 — only the wording conflates the two branches.
- **Fix**: Soften the comments to "FORBIDDEN (app pre-check; RLS zero-row is the race-proof backstop, proven in predictions.rls.test.ts)".
- **Decision**: FIXED (Fix now) — softened docblock + added clarifying note on the post-kickoff CREATE case in predictions.test.ts; corrected test-plan §6.6 wording.

### F2 — Live `it` blocks share mutable fixtures (order-dependent)

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (reliability)
- **Location**: src/actions/predictions.test.ts:225-311
- **Detail**: The create→edit→caller-scoping cases build on each other's rows. Vitest runs `it`s serially in file order by default, and the sibling files (account.test.ts, predictions.rls.test.ts) use the same style, so this is consistent and currently safe.
- **Fix**: None required — accept as house style. Only revisit if the suite is ever parallelized within a file.
- **Decision**: ACCEPTED (no action) — consistent with sibling test files; safe under Vitest serial ordering.

### F3 — 3s kickoff lead in the new write-flip is tight on slow CI

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (reliability)
- **Location**: src/db/predictions.rls.test.ts (new write-flip case, leadMs=3000)
- **Detail**: A 3s lead before kickoff could let the pre-kickoff sanity UPDATE race the boundary on a very slow runner. Mitigated by the 15s poll deadline and inherited verbatim from the existing SELECT-flip case, so it's no riskier than what already ships.
- **Fix**: None now — if CI ever flakes here, bump leadMs (both flip cases) to ~5000.
- **Decision**: ACCEPTED (no action) — inherited from the existing SELECT-flip; 15s poll deadline mitigates.

### F4 — Benign over-delivery: two past matches seeded (plan said one)

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/actions/predictions.test.ts:155-156
- **Detail**: The action test seeds a "past create" and a separate "past edit" match rather than one, to cleanly isolate the post-kickoff create case from the post-kickoff edit case. Intent-preserving improvement, not drift.
- **Fix**: None — keep as is.
- **Decision**: ACCEPTED (no action) — intent-preserving improvement, not drift.
