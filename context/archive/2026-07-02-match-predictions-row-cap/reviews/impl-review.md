<!-- IMPL-REVIEW-REPORT -->

# Implementation Review: Fix "See Others' Predictions" Zero-Points Bug

- **Plan**: context/changes/match-predictions-row-cap/plan.md
- **Scope**: All 3 phases
- **Date**: 2026-07-02
- **Verdict**: RESOLVED (triaged 2026-07-02) — was NEEDS ATTENTION
- **Findings**: 0 critical 2 warnings 3 observations — all triaged (3 FIXED, 2 ACKNOWLEDGED); 0 pending

## Verdicts

| Dimension           | Verdict |
| ------------------- | ------- |
| Plan Adherence      | PASS    |
| Scope Discipline    | WARNING |
| Safety & Quality    | WARNING |
| Architecture        | PASS    |
| Pattern Consistency | PASS    |
| Success Criteria    | PASS    |

Overall: NEEDS ATTENTION — all functional dimensions pass and the fix is
verified end-to-end (live-DB 3.3 passes with the fix; 3.4 fails with 50
truncated cells without it). The warnings are hardening/hygiene, not
correctness.

## Findings

### F1 — Over-cap live test can seed a non-local DB

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/db/match-predictions.rls.test.ts:250 (beforeAll seed)
- **Detail**: The new suite self-skips only on env PRESENCE (`dbConfigured`), not on the env pointing at a local stack. If run with prod `SUPABASE_URL` / `SUPABASE_DB_URL` + a valid service key, it creates 6 auth users and bulk-inserts ~2100 prediction/score rows into that DB. The new block's seed is far heavier than the pre-existing block, amplifying an existing latent risk.
- **Fix**: Before seeding, assert the target is loopback (`SUPABASE_URL` / `SUPABASE_DB_URL` host is 127.0.0.1/localhost) and skip/throw otherwise; ideally applied to both describe blocks.
  - Strength: Makes accidental prod seeding structurally impossible, not just convention — cheap guard at the top of beforeAll.
  - Tradeoff: A few lines; must not over-restrict legit CI hosts (a loopback check is safe for this local-only suite).
  - Confidence: HIGH — the suite is explicitly documented as local-only.
  - Blind spot: None significant.
- **Decision**: FIXED — added `assertLoopbackTarget()` guard to both `beforeAll` hooks (refuses non-127.0.0.1/localhost SUPABASE_URL/SUPABASE_DB_URL); live suite still 4/4 green.

### F2 — pageSize↔max_rows coupling is convention-only

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/paginate.ts:18 (DEFAULT_PAGE_SIZE) ↔ supabase/config.toml:18 (max_rows)
- **Detail**: `readAllPages` terminates on "page shorter than pageSize". If `max_rows` is lowered below 1000, the server truncates every page below pageSize, so the loop stops after page 1 — silently reintroducing the truncation bug this change fixes. Correct today (both 1000), but the invariant (pageSize <= max_rows) is documented in a comment, not enforced.
- **Fix**: Add a short note in supabase/config.toml next to `max_rows` pointing at `DEFAULT_PAGE_SIZE` (and vice-versa) so the coupling is discoverable.
- **Decision**: FIXED — added reciprocal COUPLING notes: config.toml `max_rows` now warns DEFAULT_PAGE_SIZE must stay <= it, and paginate.ts's constant points back at config.toml.

### F3 — Exact-multiple termination relies on omitting count:exact

- **Severity**: 🔷 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/paginate.ts:44-52
- **Detail**: When the total is an exact multiple of pageSize, the loop issues one extra out-of-range request expecting `200 []`. That holds only because the reads omit `{ count: 'exact' }` — with exact count, PostgREST can return 416 for an out-of-range offset. Fine now; a trap if a future caller adds count.
- **Fix**: Note in the `readAllPages` JSDoc that callers must not pass `count: 'exact'` (or handle 416 as end-of-data).
- **Decision**: FIXED — added a CAVEAT paragraph to the `readAllPages` JSDoc warning callers not to pass `{ count: 'exact' }` (416 on the out-of-range final page).

### F4 — Unplanned .cursor/.10x-cli-manifest.json in the feature commit

- **Severity**: 🔷 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: .cursor/.10x-cli-manifest.json (commit a11ea78, 207 lines)
- **Detail**: A 207-line auto-generated manifest change was bundled into the Phase 1 commit at the user's explicit request. Unrelated to the fix; already committed. Matches the lessons.md "unplanned-but-benign support files" pattern — flagged for the record, not a defect.
- **Fix**: None needed; optionally revert/untrack separately if it shouldn't be version-controlled.
- **Decision**: ACKNOWLEDGED — no action; committed manifest left as-is (benign, matches known lessons.md pattern).

### F5 — Plan's `astro check` criterion not green repo-wide (pre-existing)

- **Severity**: 🔷 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: src/actions/participants.test.ts, src/actions/predictions.test.ts, src/db/results-scoring.rls.test.ts
- **Detail**: `npx astro check` reports 6 errors, all in these untouched pre-existing test files. This change's own files type-check clean, and the real CI gate (`npm run lint`, strict-type-checked) is green at 0 errors. So the criterion passes for this change but not repo-wide.
- **Fix**: Track the pre-existing astro check errors as separate follow-up work.
- **Decision**: ACKNOWLEDGED — out of scope for this change; pre-existing on main. This change's files type-check clean and the CI gate (`npm run lint`) is 0 errors. Left for separate follow-up.
