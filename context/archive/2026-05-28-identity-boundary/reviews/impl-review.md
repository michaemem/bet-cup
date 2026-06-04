<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Identity Boundary (F-01)

- **Plan**: context/changes/identity-boundary/plan.md
- **Scope**: All 4 phases (full plan)
- **Date**: 2026-06-01
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 6 warnings, 4 observations

## Automated re-verification (run during review)

- `npm run lint` — clean ✅
- `npm test` — 6/6 passing (src/middleware.test.ts) ✅
- `npm run check:wrangler` — OK (nodejs_compat present) ✅
- `npm run build` — succeeds on Node 22 ✅
- Phase-1 DB criteria (migration apply, `db:types`, RLS `psql` checks) require a live local Supabase stack — NOT re-verified here; marked done at commit 6428ccd.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | WARNING |

## Findings

### F1 — profiles_public granted to anon (PostgREST exposure)

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality / Scope Discipline
- **Location**: supabase/migrations/20260528232000_identity_boundary.sql:73
- **Detail**: `grant select on public.profiles_public to authenticated, anon` exposes every user's id + display_name + timestamps to anyone holding the Supabase anon key via PostgREST (/rest/v1/profiles_public). Independent of the default-deny HTTP middleware — the DB grant is a separate trust boundary the Worker gate does not protect. The plan narrative (plan.md:77) says "granted to authenticated" while the contract (plan.md:106) says "authenticated, anon" — the plan contradicts itself. Exposure is bounded (no legal_name, no roles) but is a real product call.
- **Fix A ⭐ Recommended**: Revoke anon, keep authenticated-only (new follow-up migration).
  - Strength: Closes the unauthenticated PostgREST read path; matches the plan's own narrative intent (plan.md:77) and the "private by default" PRD posture. No app code queries profiles_public as anon today.
  - Tradeoff: Needs a follow-up migration (applied migration can't be edited); a future public surface would need to re-grant.
  - Confidence: MED — no current anon caller found, but S-04 leaderboard isn't built yet.
  - Blind spot: Haven't confirmed whether display names are intended as public tournament metadata.
- **Fix B**: Keep anon grant; reconcile plan text to say so explicitly.
  - Strength: Preserves current behavior; documents the decision.
  - Tradeoff: Leaves an unauthenticated read path open by design.
  - Confidence: MED — depends on product intent for display names.
  - Blind spot: Same as above.
- **Decision**: FIXED via Fix A — new migration supabase/migrations/20260601180000_revoke_profiles_public_anon.sql revokes SELECT from anon.

### F2 — Redirect responses ship without security headers

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/middleware.ts:44,47
- **Detail**: The two `return context.redirect(...)` paths short-circuit before the SECURITY_HEADERS loop (lines 50-53). Every default-deny redirect to /auth/signin and the authed /auth/signin→/dashboard redirect lack HSTS, CSP, X-Frame-Options, etc. Plan manual check 2.10 ("security headers still set on every response") was marked [x] but redirects are a real gap — effectively rubber-stamped.
- **Fix**: Build the redirect Response, apply SECURITY_HEADERS, then return it (or wrap all outbound responses through one helper).
  - Strength: Restores "headers on every response"; small refactor at the bottom of the middleware.
  - Tradeoff: None significant.
  - Confidence: HIGH — headers loop already exists; just apply it earlier.
  - Blind spot: None significant.
- **Decision**: FIXED — added `withSecurityHeaders` helper in src/middleware.ts applied to both redirects and the next() response.

### F3 — Silent failure swallowing in middleware + loadProfile

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/supabase.ts:41-45, src/middleware.ts:30-32
- **Detail**: (a) loadProfile returns null on any profiles error and ignores the user_roles query error entirely — yet its docstring (lines 30-32) says a null return "signals a race / inconsistency worth logging" and nothing is logged. (b) middleware never destructures `error` from supabase.auth.getUser(); a transient Supabase outage looks like "logged out" and silently redirects authed users to /auth/signin.
- **Fix**: Capture and log the error branches server-side; decide whether getUser() hard failures should fail closed (503) rather than masquerade as anonymous.
  - Strength: Turns invisible auth/DB failures into diagnosable signals before downstream slices depend on profile.
  - Tradeoff: Minor — adds a logging dependency / decision on fail-open vs fail-closed.
  - Confidence: HIGH — localized to two functions.
  - Blind spot: No structured-logging util exists yet (roadmap-parked).
- **Decision**: FIXED — console.error logging added to loadProfile (both query branches) and middleware getUser() error; fail-open redirect retained.

### F4 — Seed template substitution has no SQL escaping

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: scripts/seed-template.mjs:31
- **Detail**: Placeholders are filled with raw string replace. An ADMIN_EMAIL or ADMIN_PASSWORD containing a single quote breaks the generated supabase/seed.sql (or could inject SQL). Local-dev only and operator-controlled, so impact is low, but it's a sharp edge.
- **Fix**: Escape single quotes (`'` → `''`) on both values before substitution.
- **Decision**: FIXED — added `sqlEscape` helper in scripts/seed-template.mjs applied to ADMIN_EMAIL and ADMIN_PASSWORD.

### F5 — isPublic() prefix match has no path boundary

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/middleware.ts:9-10
- **Detail**: `pathname.startsWith(route)` treats any path sharing a public prefix as public. A future route like /auth/signin-backdoor or /api/auth/signinX would be served without auth. No such route exists today, but it's a latent default-deny bypass.
- **Fix**: Require an exact match or segment boundary: `pathname === route || pathname.startsWith(route + "/")`.
- **Decision**: FIXED — isPublic() now matches exact path or `/`-delimited segment boundary in src/middleware.ts.

### F6 — Stale / contradictory documentation around the DEFINER fix

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency / Plan Adherence
- **Location**: plan.md:78,107-109; README.md:98-102
- **Detail**: Commit a2f7c15 correctly switched is_admin/is_participant/current_user_roles from SECURITY INVOKER to SECURITY DEFINER to break RLS recursion (the migration's inline comment now documents this well). But the plan text still prescribes SECURITY INVOKER (plan.md:78, 107-109), and the README "first-time setup" still says `npx supabase start` with no ADMIN_EMAIL step — inconsistent with the "Local admin seed" section that requires `npm run db:start`.
- **Fix**: Append a plan addendum noting the INVOKER→DEFINER fix; reconcile README first-time-setup to use `npm run db:start`.
- **Decision**: FIXED — added "Addenda (post-implementation)" section to plan.md (DEFINER fix, F1 anon revoke, orphan cleanup, loadProfile two-query); README first-time-setup steps 3 & 5 now use `npm run db:start` / `npm run db:stop`.

### F7 — loadProfile uses two round-trips, not the planned single query

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency / Performance
- **Location**: src/lib/supabase.ts:35-45
- **Detail**: Plan (plan.md:273) specified a single SQL with array_agg of roles; implementation does two Supabase queries (profiles, then user_roles). Functionally identical, unmeasurable at 5-20 users. Flagged only because the plan's "Critical Implementation Details" called the single round-trip out explicitly and warned S-04 may copy the pattern.
- **Fix**: Optional — collapse to one query (RPC or nested select) before a downstream slice copies the two-query shape per row.
- **Decision**: SKIPPED — a faithful single round-trip needs a DB function/view + `npm run db:types` (no direct FK between profiles and user_roles rules out PostgREST embedding). Kept the two-query version; documented in the plan addendum.

### F8 — Unplanned deletions of Topbar.astro / Welcome.astro

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/components/Topbar.astro, src/components/Welcome.astro (deleted, 562bbbb)
- **Detail**: Not in the plan's "What We're NOT Doing" or its file list. Investigation confirms both were orphaned starter scaffold — Welcome was only imported by the old index.astro (replaced in p2), Topbar only by Welcome (which linked to /auth/signup). Benign cleanup, just undocumented. Other EXTRA changes (eslint.config.js, .prettierignore, .prettierrc.json, the astro-middleware test stub) are supporting and benign.
- **Fix**: None needed — optionally note the orphan cleanup in the F6 plan addendum.
- **Decision**: SKIPPED — no code change; the deletion is recorded in the plan addendum.

### F9 — Middleware test coverage gaps

- **Severity**: OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: src/middleware.test.ts
- **Detail**: The six planned tests all exist, are meaningful, and pass (verified 6/6). But they don't cover the failure modes flagged above: security headers on responses (F2), the createClient→null env-missing branch, getUser/loadProfile error paths (F3), or prefix-collision routes (F5). The plan explicitly allowed adding a 7th+ test for these.
- **Fix**: Add targeted cases when addressing F2/F3/F5 so the regressions can't silently return.
- **Decision**: FIXED — added 3 tests to src/middleware.test.ts (security headers on redirect, /auth/signin-backdoor prefix-collision treated as private, createClient→null env-missing branch). Now 9/9 passing; lint clean (3 expected no-console warnings only).

### F10 — Admin seed has no idempotency guard

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: supabase/seed.sql.template:21-78
- **Detail**: The auth.users INSERT has no ON CONFLICT guard. Safe on `db reset` (clean DB, the intended workflow), but a re-run without reset fails on the duplicate email rather than skipping idempotently.
- **Fix**: Optional — add ON CONFLICT DO NOTHING if re-seed-without-reset is ever a workflow.
- **Decision**: FIXED — added untargeted `on conflict do nothing` to both the auth.users and auth.identities inserts in supabase/seed.sql.template (when the users insert is a no-op, the CTE yields no rows so identities is a no-op too). Not re-verified here — requires local `npm run db:start`.
