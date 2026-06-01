<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Tournament & Matches (S-02)

- **Plan**: context/changes/tournament-and-matches/plan.md
- **Mode**: Deep
- **Date**: 2026-06-01
- **Verdict**: REVISE
- **Findings**: 1 critical, 3 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | WARNING |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | FAIL |
| Plan Completeness | WARNING |

## Grounding

8/8 paths ✓, 3/3 symbols ✓ (is_admin `identity_boundary.sql:82`, set_updated_at `:31`, `locals.profile.roles`), brief↔plan ✓.

## Findings

### F1 — RLS test can't run where the plan puts it

- **Severity**: ❌ CRITICAL
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Plan Completeness / Blind Spots
- **Location**: Phase 1 §3 + Success Criteria (step 1.5); brief Open Risk #4
- **Detail**: Phase 1 lists "RLS/edit-lock test passes: `npm test`" as an automated criterion with `src/db/matches.rls.test.ts`, suggesting "mirror the `src/middleware.test.ts` Supabase-mock OR a local-DB integration approach." (1) The mock approach cannot test RLS — `middleware.test.ts` mocks `@/lib/supabase` to avoid a real client; RLS is enforced by Postgres, so a mock proves nothing. (2) The live-DB approach can't satisfy `npm test` in CI: CI runs `npm test` (`.github/workflows/ci.yml:22`) on a runner with no Supabase/Docker, so a real-DB test fails (red gate) or gets skipped (false assurance on the FR-008 boundary). The brief flags this as unresolved but the plan promotes it to a must-pass automated criterion.
- **Fix A ⭐ Recommended**: Gate the RLS test behind a live-DB guard; drop it from Phase 1 `npm test`, list under Manual/Integration verification with the local command (`describe.skipIf(!process.env.SUPABASE_DB_URL)` or a `test:integration` script).
  - Strength: Real RLS coverage where meaningful; CI stays green; matches AGENTS.md CI gate.
  - Tradeoff: Boundary not pinned every CI run; relies on local + manual Studio checks (1.6/1.7).
  - Confidence: HIGH — verified CI has no DB and the mock harness can't reach Postgres.
  - Blind spot: Whether a `supabase start` CI job is wanted — bigger scope, not assumed.
- **Fix B**: Add a Supabase service to the CI `ci` job and run the integration suite there.
  - Strength: Boundary pinned on every push/PR.
  - Tradeoff: New CI infra (Docker/`supabase start`), slower pipeline, contradicts the lean CI gate.
  - Confidence: MED — feasible but a meaningful CI redesign.
  - Blind spot: DB-service cold-start/flakiness in CI unmeasured.
- **Decision**: Fixed via Fix A

### F2 — Locked-match edit silently "succeeds" (RLS UPDATE no-op)

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots / End-State Alignment
- **Location**: Phase 2 §5 (`matches.update`), Implementation Approach
- **Detail**: The edit-lock truth is RLS `UPDATE USING (kickoff_time > now())`. A `USING` clause that filters a row out does NOT raise an error — the UPDATE affects zero rows and PostgREST returns success. The Action contract ("writes via the client (RLS is the backstop)" + app pre-check "for a friendly message") never says the handler must detect the zero-row outcome. If the pre-check races (row kicks off between read and write) or is bypassed, the UI reports success while nothing changed; the Desired End State ("edit is refused … UI marks the match locked") isn't reliably met by RLS alone. (INSERT denials DO error via `WITH CHECK`, so add/bulk are fine — UPDATE-specific.)
- **Fix**: In `matches.update`, chain `.update(...).select()` and treat an empty returned set as a lock failure — throw a friendly `ActionError` (FORBIDDEN / "match already kicked off") instead of returning success. State this in the Action contract and add it to the Phase 1 RLS test assertions.
  - Strength: Closes the gap with the DB still source of truth; no reliance on the pre-check winning the race.
  - Tradeoff: One extra `.select()` round-trip on edit (negligible).
  - Confidence: HIGH — standard PostgREST/RLS behavior.
  - Blind spot: None significant.
- **Decision**: Fixed via Fix

### F3 — New admin-route gate ships without an automated test

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 2 §6 (middleware admin gate)
- **Detail**: Phase 2 extends `src/middleware.ts` with an `ADMIN_ROUTES` redirect for non-admins — a security boundary. `src/middleware.test.ts` already exercises the default-deny gate with the mock harness and would trivially cover this, yet the plan verifies it only manually (3.7). Of the three doors S-02 adds (route gate, table RLS, edit-lock), the route gate is the one easily unit-tested in CI today and is the only one left untested.
- **Fix**: Add admin-route cases to `src/middleware.test.ts` (participant-only → 302 `/dashboard`; admin → 200; prefix-collision `/administrators` stays private) and list under Phase 2 automated verification.
- **Decision**: Fixed via Fix

### F4 — Kickoff representation underspecified across picker, schema, and paste

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 2 §2 (`matchInputSchema`), Phase 3 §3 (MatchForm), Phase 2 §4 (bulk parse)
- **Detail**: `matchInputSchema` declares `kickoffLocal: string (wall-clock)` and transforms to a UTC Date, but the one-by-one MatchForm uses Calendar + `<input type="time">`, which yields a JS `Date` in the browser zone — and that must be reinterpreted as tournament-zone wall-clock (browser zone ≠ tournament zone is the whole point). The plan doesn't say how the picker value becomes `kickoffLocal`, nor what canonical wall-clock format the bulk path must produce so the same schema parses both. Also, because the schema transforms types, `zodResolver` needs `useForm<z.input, any, z.output>` (in research, not the plan).
- **Fix A ⭐ Recommended**: Pin one canonical wall-clock string (e.g. `"YYYY-MM-DD HH:mm"`); MatchForm formats the picker Date to it via local-part getters (no zone math) before submit; `parseMatchPaste` normalizes to the same format; note the `z.input/z.output` useForm signature.
  - Strength: One parse path for both flows; removes the picker-Date vs string ambiguity driving TZ drift into S-03/S-04.
  - Tradeoff: Slightly more spec up front in Phase 2/3.
  - Confidence: HIGH — matches the research's own TZDate + resolver notes.
  - Blind spot: Seconds handling (`HH:mm` vs `HH:mm:ss`) — pick one.
- **Fix B**: Make the schema accept a `Date` (picker-native) and parse paste strings to Date before validate.
  - Strength: No string format to standardize on the form side.
  - Tradeoff: Bulk path still needs its own string→Date parse; "validate identically client & server" weakens.
  - Confidence: MED — splits the validation path the plan wanted unified.
  - Blind spot: Reinterpreting a browser-zone Date as tournament wall-clock is still required and subtle.
- **Decision**: Fixed via Fix A

### F5 — shadcn primitive naming: Field vs Form

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 §1–3
- **Detail**: The plan adds `form input` and wires errors via `FormField`/`FormMessage`, but the research's date-picker snippet uses the newer `Field`/`FieldGroup`/`FieldLabel` API from `@/components/ui/field`. The two families differ; plan and research disagree on which to use.
- **Fix**: After `npx shadcn add`, standardize on whichever family the registry emits; drop the stale reference.
- **Decision**: Fixed via Fix

### F6 — "Lands on an admin area" has no navigation path

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: End-State Alignment
- **Location**: Desired End State; Phase 3 §4
- **Detail**: Desired End State says the admin "signs in, lands on an admin area," but `signin.ts` redirects to `/dashboard` and no phase adds a link/redirect from `/dashboard` (or post-signin) to `/admin`. The admin reaches `/admin` only by typing the URL. Not blocking (success criteria test only direct visits) but the "lands on" promise isn't delivered.
- **Fix**: Add a dashboard → `/admin` link for admins (or branch the post-signin redirect on role).
- **Decision**: Fixed via Fix
