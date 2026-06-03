<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Identity Boundary (F-01) Implementation Plan

- **Plan**: `context/changes/identity-boundary/plan.md`
- **Mode**: Deep
- **Date**: 2026-05-28
- **Verdict**: REVISE
- **Findings**: 0 critical | 2 warnings | 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | WARNING |
| Architectural Fitness | PASS |
| Blind Spots | PASS |
| Plan Completeness | WARNING |

## Grounding

16/17 paths ✓ (lessons.md absent — no priors applied), 5/5 symbols ✓ (PROTECTED_ROUTES, createClient, enable_signup×2, smoke job at ci.yml:48-78), brief↔plan ✓

## Findings

### F1 — "Keep createClient intact" contradicts the required type edit

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 2 — Changes Required §3 (Profile loader)
- **Detail**: Phase 2 says "Keep the existing `createClient` export intact" while also saying to type `loadProfile` with `SupabaseClient<Database>`. These are contradictory: `createServerClient(...)` in `supabase.ts:9` carries no `<Database>` generic. Passing the return value of `createClient()` into `loadProfile(supabase: SupabaseClient<Database>)` will fail TypeScript strict-mode. The fix requires adding a `Database` import and changing `createServerClient(...)` to `createServerClient<Database>(...)` inside `createClient` — an edit the plan doesn't list. The CI lint gate catches this at build time, but an implementer reading "keep intact" would be confused when tsc rejects the call site in middleware.
- **Fix A ⭐ Recommended**: Amend the `supabase.ts` Changes Required entry to explicitly state: "add `import type { Database } from '@/db/database.types'` and change `createServerClient(...)` → `createServerClient<Database>(...)`. The exported function signature is unchanged — only the internal generic call is updated."
  - Strength: Removes the contradiction; implementer has a clear one-line internal diff and knows the public API is stable.
  - Tradeoff: None — the edit is mandatory regardless.
  - Confidence: HIGH — no behavior change, only type precision.
  - Blind spot: None significant.
- **Fix B**: Remove the typed `SupabaseClient<Database>` parameter; type `loadProfile` with the weaker `SupabaseClient` (no generic).
  - Strength: Truly keeps `createClient` intact; no import needed.
  - Tradeoff: Loses type safety on the DB query; breaks Desired End State §5 which expects typed `Database` usage.
  - Confidence: LOW — weakens the plan's stated end state.
  - Blind spot: Downstream slices relying on typed DB access would need a separate retrofit.
- **Decision**: PENDING

---

### F2 — Phase 4 Changes Required is missing the ci.yml edit

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 4 — Changes Required
- **Detail**: The plan says "add `npm test` to the `ci` job between `npm run lint` and `npm run build`" (overview + Manual Verification 4.7), but no entry for `.github/workflows/ci.yml` appears in Phase 4 Changes Required. The three entries there are `package.json`, `vitest.config.ts`, and `src/middleware.test.ts`. An implementer following only the Changes Required block will skip the CI yaml edit entirely; checklist item 4.7 would then fail at manual review with no guidance on where in the plan the change was supposed to come from.
- **Fix**: Add a Phase 4 Changes Required entry for `.github/workflows/ci.yml` with the exact one-line edit: insert `- run: npm test` after `- run: npm run lint` (ci.yml:21) and before `- run: npm run build` (ci.yml:22).
- **Decision**: PENDING

---

### F3 — Wrong line number for first enable_signup in config.toml

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 — Changes Required §3
- **Detail**: Plan says "`[auth].enable_signup = false` (line 161 in current file)". Actual line is 169. Line 161 is a comment about `signing_keys_path`. The `[auth.email]` reference (line 204) is correct.
- **Fix**: Change "line 161" → "line 169" in Phase 3 §3.
- **Decision**: PENDING

---

### F4 — signout.ts preserves redirect to / — 2-hop post-signout chain

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Lean Execution
- **Location**: Phase 2 — Changes Required §7
- **Detail**: Phase 2 adds `prerender = false` to `signout.ts` with "No behavior change." The handler currently redirects to `/`. After the refactor, the post-signout flow is: POST /api/auth/signout → redirect `/` → middleware (unauthed) → redirect `/auth/signin`. Two redirects instead of one. The plan documents this chain in Manual Verification 2.11 so it's intentional, but it's an easy simplification.
- **Fix**: Optionally change signout.ts redirect from `"/"` to `"/auth/signin"` and update Manual Verification 2.11 accordingly.
- **Decision**: PENDING

---

### F5 — @testing-library/jest-dom mentioned in Phase 4 overview but absent from devDependencies contract

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 4 — Changes Required §1
- **Detail**: Phase 4 overview mentions adding `@testing-library/jest-dom` "for future component-test ergonomics," but the `Contract: New devDependencies:` block lists only `vitest`, `@vitest/coverage-v8`, and `happy-dom`. An implementer following the contract installs 3 packages; one following the overview installs 4.
- **Fix**: Either add `@testing-library/jest-dom` to the devDependencies contract block (and note the vitest matchers setup needed), or remove the mention from the overview (recommended — it's a pre-emptive addition with no backing test in this plan).
- **Decision**: PENDING

---

### F6 — Vitest test 1 mock shape conflates two distinct middleware paths

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 4 — Changes Required §3, Test 1
- **Detail**: Test 1 says "mocks `createClient` to return `null` (no env) OR returns a client whose `auth.getUser()` resolves to `{ data: { user: null } }`". These exercise two different code paths: when `createClient` returns null, the middleware skips the `auth.getUser()` branch entirely; when a client is returned but user is null, the auth branch runs. Test 6 already covers the "unauthed → locals null" assertion. Using only one mock shape in test 1 keeps coverage clean.
- **Fix**: Change Test 1 mock description to "mocks `createClient` to return a client whose `auth.getUser()` resolves to `{ data: { user: null } }`" and assign the null-client (env missing) scenario to test 6 if needed.
- **Decision**: PENDING
