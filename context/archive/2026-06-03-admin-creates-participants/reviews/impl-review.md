<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Admin Creates Participants (S-01)

- **Plan**: context/changes/admin-creates-participants/plan.md
- **Scope**: All 4 phases of 4
- **Date**: 2026-06-04
- **Verdict**: APPROVED
- **Findings**: 0 critical, 2 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Summary

Load-bearing constraints all hold: service-role key read in exactly one production module (`src/lib/supabase-admin.ts`) with one importer (`src/actions/index.ts`); `synthEmail` shared by create + sign-in so they can't drift; reveal-once panel does not auto-reload; Web Crypto passwords, never logged; additive `handle_new_user` trigger preserving `SECURITY DEFINER` + `set search_path = public`; safe migration ordering (add-nullable → backfill → unique-index → not-null); admin self-row excluded from the participant list. No DRIFT, no MISSING, no CRITICAL. Automated success criteria re-verified at HEAD (lint, test 42 passed/8 skipped, check:wrangler, build).

## Findings

### F1 — Over-broad 422 mapping can mislabel a bad username as "taken"

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/actions/index.ts:135 (+ src/lib/schemas/participant.ts:17)
- **Detail**: Duplicate detection fires on `error.code === "email_exists" || error.status === 422`. The username regex `/^[a-z0-9._-]+$/` permits leading/trailing/consecutive separators (`.bob`, `bob.`, `a..b`), which form RFC-invalid email local-parts. GoTrue can reject those with a 422 that is NOT `email_exists` (a format error); the `|| 422` catch-all then mislabels it "That username is taken." for a name that isn't actually taken.
- **Fix A ⭐ Recommended**: Tighten the username regex to forbid leading/trailing/consecutive separators so every accepted username is a valid email local-part.
  - Strength: Fixes root cause; all accepted handles become loginnable + valid emails. Keeps the 422 fallback as defense for genuine duplicates.
  - Tradeoff: Slightly stricter usernames; new regex + a schema test.
  - Confidence: HIGH — schema is shared by form + Action, so one edit covers both.
  - Blind spot: None significant.
- **Fix B**: Gate strictly on `error.code === "email_exists"` and drop the `|| error.status === 422` fallback.
  - Strength: Removes the mislabel path entirely; format errors fall through to the generic 500.
  - Tradeoff: Loses the resilience the plan deliberately added in case GoTrue stops sending `code`.
  - Confidence: MEDIUM — depends on GoTrue keeping `email_exists`.
  - Blind spot: A future GoTrue that changes the code would 500 instead of showing the friendly message.
- **Decision**: FIXED via Fix A — tightened regex to `/^[a-z0-9]+([._-][a-z0-9]+)*$/` in src/lib/schemas/participant.ts + added rejection test.

### F2 — Sign-in reflects the raw GoTrue error message to the client

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/api/auth/signin.ts:37
- **Detail**: `participants.create` never surfaces raw messages (to avoid leaking the `@betcup.local` scheme), but `signin.ts` redirects with `error=${error.message}` straight from GoTrue. In practice GoTrue returns curated strings ("Invalid login credentials") so leak risk is low, but it is inconsistent with the change's own discipline, and the plan specified a generic "Invalid credentials" on failure.
- **Fix**: Map failures to a generic "Invalid username or password." and `console.error` the raw error server-side (mirroring `internalError`).
- **Decision**: FIXED — generic message + server-side `console.error` in src/pages/api/auth/signin.ts.

### F3 — Phase-2 isolation grep criterion softened by test files

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: src/actions/participants.test.ts
- **Detail**: Criterion 2.5 said `rg SUPABASE_SERVICE_ROLE_KEY src` returns only `supabase-admin.ts`. It now also matches `participants.test.ts` and the pre-existing `matches.rls.test.ts` — but those read `process.env` in the test harness, not the production secret. Production isolation is intact (`supabase-admin.ts` is the only `astro:env/server` reader; one importer). No action needed; flagged for accuracy.
- **Decision**: ACCEPTED-AS-RULE (lessons.md: "Isolation criteria should target production reads, not literal grep across src/") + FIXED — plan criterion 2.5 reworded to scope the grep with `--glob '!*.test.*'`.

### F4 — Unplanned .gitignore un-ignore of .env.example

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: .gitignore
- **Detail**: Necessary so the planned `.env.example` edit is committable. Benign (matches the "unplanned-but-benign support file" lessons.md entry). No action.
- **Decision**: SKIPPED — accepted as benign.

### F5 — Sign-in client validation weaker than server (password length)

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/components/auth/SignInForm.tsx:18-28
- **Detail**: Client checks non-empty; server requires `min(6)`. A 1–5 char password yields a reflected zod message. Cosmetic; tied to F2. Optional.
- **Decision**: FIXED — added a client-side min-length(6) check in src/components/auth/SignInForm.tsx.

## Forward-looking note (not an S-01 defect)

F-01's `profiles_public` view does not expose `username`, so a future *non-admin* slice that needs to show usernames will need to add it there. `/admin/participants` is admin-only and reads `profiles` directly under admin RLS, so S-01 is correct as-is.
