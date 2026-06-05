<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Account Settings — Change Password & Display Name

- **Plan**: context/changes/participant-changes-password/plan.md
- **Mode**: Deep
- **Date**: 2026-06-05
- **Verdict**: REVISE
- **Findings**: 0 critical, 3 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | WARNING |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

## Grounding

13/13 paths ✓ (5 new files correctly absent), symbols ✓ (sessionClient / inputError / internalError / `server` action groups / `profiles_update` RLS / `profile.displayName` / env-server test stub), brief↔plan ✓.

## Findings

### F1 — Current-password verification rotates the user's live session

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architectural Fitness
- **Location**: "Critical Implementation Details" + Phase 1 §2 (`verifyCurrentPassword`)
- **Detail**: Verification calls `signInWithPassword` on the SSR *session* client (bound to the caller's cookies). That mints a brand-new GoTrue session for the current device and rewrites its auth cookies via `setAll`. The subsequent `signOut({ scope: "others" })` then revokes every session except this new one — including the browser's *original* session. So the acting device stays logged in **only** if the new session's `Set-Cookie` reaches the browser. This is the first action in the codebase to mutate auth cookies (all existing actions only read/write the DB), so "Astro propagates action-set `Set-Cookie`" is unverified-in-this-repo and sits on the most fragile part of the flow. Caught by manual gate 2.6, but a failure forces a late redesign.
- **Fix A**: Keep SSR-client verification; treat cookie propagation as load-bearing.
  - Strength: No new client; matches the plan as written.
  - Tradeoff: Live session is rotated on every verify; correctness hinges on Astro emitting the action's `Set-Cookie`, which has no precedent here.
  - Confidence: MEDIUM — should work, but unproven in this codebase.
  - Blind spot: Behavior under `window.location.reload()` timing not verified.
- **Fix B ⭐ Recommended**: Verify on a transient non-persistent client.
  - Approach: `signInWithPassword` on a throwaway `createServerClient`/supabase-js client with `auth.persistSession: false` (NOT the session client).
  - Strength: The user's live session is never touched, so `signOut({ scope: "others" })` targets only genuinely-other devices and the "keep current device" guarantee no longer depends on cookie propagation. The throwaway verify-session is reaped by the same `signOut(others)`. Removes the fragile ordering note.
  - Tradeoff: A few extra lines to build the transient client inline.
  - Confidence: HIGH — decouples verification from the live cookie lifecycle.
  - Blind spot: One extra GoTrue round-trip (negligible at 5–20 users).
- **Decision**: FIXED via Fix B

### F2 — Integration-test precedent doesn't exercise `sessionClient`

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §4 (`src/actions/account.test.ts`)
- **Detail**: The plan says to mirror `src/actions/participants.test.ts` and "invoke the action handler." But `participants.create`'s handler only touches `context.locals` (`requireAdmin`) and uses the service-role admin client — the harness passes just `{ locals: { profile: { roles } } }` (participants.test.ts:61-67). The new account actions go through `sessionClient(context)`, which reads `context.locals.user` AND builds the SSR client from `context.request.headers` + `context.cookies` (index.ts:89-99 → supabase.ts:8-26, `setAll` calls `cookies.set`). The cited harness never constructs `request` or `cookies`, so "mirror the harness" understates the work. (Env names are fine: the stub maps `SUPABASE_KEY ← SUPABASE_ANON_KEY`.)
- **Fix**: Spell out the account-test context shape in Phase 1 §4 — a `Request` with an (empty is fine) `Cookie` header, an `AstroCookies` stub exposing `get`/`getAll`/`set` (`set` may be a no-op since the handler establishes its own session in-memory), and `locals.user = { id, email }`. Note this differs from the participants harness (no service-role client).
- **Decision**: FIXED — Phase 1 §4 now specifies the full `context` shape, the authenticated-session-client requirement (seed `sb-<ref>-auth-token` into the `request` Cookie header), the env vars, and a fallback. Sharpened during triage: the mutation runs on an authenticated SSR client under RLS, so the test must inject a real signed-in session, not just a stub.

### F3 — Phase 3 Success Criteria bullet has no Progress entry

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 "Automated Verification" (plan.md:216-218) vs Progress (plan.md:301-307)
- **Detail**: Phase 3 lists one `#### Automated Verification:` bullet that is explicitly a no-op ("`npm run lint` ... does not lint markdown ... rely on manual review"). The Progress block for Phase 3 has only a Manual subsection (3.1–3.3) — no automated entry. Per the Progress↔Phase mechanical contract, every Success Criteria bullet should map to a Progress checkbox. The Progress block itself is well-formed and parseable, so this won't break `/10x-implement`, but it's a literal contract mismatch.
- **Fix**: Drop the no-op "Automated Verification" bullet from Phase 3 (the manual checks already cover it), so Phase↔Progress align cleanly.
- **Decision**: FIXED — removed the Phase 3 "Automated Verification" block; Phase 3 now has only Manual criteria matching Progress 3.1–3.3.

### F4 — `verifyCurrentPassword` conflates all GoTrue errors with "wrong password"

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1 §2 — `verifyCurrentPassword` helper
- **Detail**: The contract maps EVERY `signInWithPassword` failure to `inputError("currentPassword", "Current password is incorrect.")`. That includes transient failures and GoTrue's sign-in rate limiter (the change form reuses the sign-in path), which would mislead the user and mask real faults. Mild tension with the plan's own "log raw errors server-side" discipline.
- **Fix**: In the helper, distinguish invalid-credentials (→ `currentPassword` field error) from other errors (→ `internalError` + `console.error`), rather than collapsing all failures to the field error.
- **Decision**: FIXED — Phase 1 §2 helper contract (via F1) and the "Error discipline" bullet now split invalid-credentials (field error) from other failures (internalError + log).
