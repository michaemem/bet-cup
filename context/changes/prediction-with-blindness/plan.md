# S-03 Prediction-with-Blindness Implementation Plan

## Overview

Implement S-03: a logged-in participant views the tournament's match list with kickoff times, submits and edits a `(home, away)` score prediction for any match before its kickoff, and — the integrity-load-bearing part — **only the predictor can read their prediction before kickoff** (not other participants, not the admin). After kickoff, the match is locked for editing and all predictions become visible to everyone. The blindness invariant (FR-015) is enforced at the database (RLS) layer, not just the UI, and proven by a CI-run integration test.

## Current State Analysis

The codebase has clean, consistent precedents for every piece (see `context/changes/prediction-with-blindness/research.md` for the full map):

- **No `predictions` table exists.** S-02's migration explicitly defers participant read on `matches`/`tournaments` and the participant kickoff-lock to S-03 (`supabase/migrations/20260602180000_tournament_and_matches.sql:51-52`).
- **Kickoff is already modeled**: `matches.kickoff_time timestamptz` (UTC at rest), `tournaments.time_zone` IANA zone for wall-clock display; index `matches_tournament_kickoff_idx on (tournament_id, kickoff_time)` covers the ordered-list query and the `kickoff_time` predicate.
- **Kickoff-lock precedent (to mirror)**: `matches_update USING (public.is_admin() and kickoff_time > now())` + app pre-check + zero-row post-write guard (`...tournament_and_matches.sql:103-107`, `src/actions/index.ts:215-254`).
- **Per-user RLS precedent**: `profiles_select USING (auth.uid() = id or public.is_admin())` — but predictions must NOT include the `is_admin()` branch (admin blindness, FR-017).
- **Helper-function precedent**: `public.is_admin()` is a `stable security definer` SQL function with `set search_path = ''` (`...identity_boundary.sql:82-93`).
- **Server stack**: Astro Actions in `src/actions/index.ts` (zod from `src/lib/schemas/`), session SSR client `src/lib/supabase.ts`, service-role isolated to `src/lib/supabase-admin.ts` (only importer: `participants.create`).
- **UI stack**: SSR page pattern `src/pages/admin/index.astro` (server fetch → `formatInZone`/`isPast` → `client:load` island); form pattern `src/components/admin/TournamentForm.tsx` (RHF + `zodResolver` + `actions.*` + `isInputError`); shadcn primitives present: `button, input, label, form, calendar, popover`.
- **Test/CI**: live-DB RLS harness `src/db/matches.rls.test.ts` (Vitest, `describe.skipIf(!dbConfigured)`); CI (`.github/workflows/ci.yml`) has `ci` → `smoke` → `deploy` jobs and does NOT boot Supabase, so RLS tests currently never run in CI.

## Desired End State

A participant can sign in, open `/predictions`, see every match (ordered by kickoff) with its local kickoff time, enter/edit a score for any not-yet-kicked-off match, and see only their own predictions pre-kickoff. A second participant and the admin querying the same pre-kickoff prediction get **zero rows** at the database layer. After kickoff, the form is locked and all predictions are readable. A `predictions.rls.test.ts` asserts all of this and **runs in CI** against a real Supabase stack.

Verify: `npm run lint`, `npm test`, `npm run build` pass; the new CI `rls` job passes; manual walkthrough with two accounts confirms blindness and the post-kickoff reveal.

### Key Discoveries:

- Kickoff lives on `matches`, so the predictions policies need to reach `matches.kickoff_time` — done via a `match_is_kicked_off(match_id)` helper (decision below), mirroring the `is_admin()` helper style (`...identity_boundary.sql:82-93`).
- The `matches.update` action is the exact template for "app pre-check + RLS zero-row guard" (`src/actions/index.ts:215-254`).
- Schemas use an input/output split when `.transform()` changes types (`src/lib/schemas/match.ts:14-17`); the prediction schema does not transform, so a single value type suffices (simpler, like `matchFormSchema`).
- The RLS harness already creates a participant via service-role and signs in per-role (`src/db/matches.rls.test.ts:64-88`); the predictions test needs a **second** participant to prove cross-participant blindness.

## What We're NOT Doing

- **No scoring, results, or leaderboard** — that is S-04. The `predictions` table has no points/result columns.
- **No "who has predicted" indicator** to other participants pre-kickoff (US-01 optional AC) — deferred to keep the blindness surface minimal; no cross-user read of `predictions` before kickoff exists at all.
- **No append-only prediction history** — one row per `(predictor, match)`, edits overwrite (FR-013).
- **No admin override / admin visibility** into pre-kickoff predictions — admin is a participant here (FR-017).
- **No new auth/route-protection mechanism** — the existing default-deny middleware already gates a non-public, non-admin route.
- **No client-side clock as source of truth** — server/DB `now()` is authoritative; any client hint is cosmetic.

## Implementation Approach

Build the slice bottom-up as one vertical: DB (table + RLS + helper + opened reads) → server (schema + upsert action on the session client) → UI (`/predictions` page + island) → verification (RLS test + CI job). Every invariant is enforced at the DB and re-checked in the Action layer (defense-in-depth, the house style). The blindness SELECT policy is owner-OR-post-kickoff with **no admin branch**; writes are owner-AND-not-kicked-off, enforced by RLS `WITH CHECK`/`USING` plus an app pre-check.

## Critical Implementation Details

- **Admin is NOT exempt from prediction blindness.** Unlike every other per-user policy in the schema, the `predictions` SELECT policy must omit `public.is_admin()`. This is the single most important line in the slice (FR-015/FR-017).
- **The upsert must not bypass the kickoff lock via INSERT.** `matches` only locks UPDATE; for predictions, BOTH the INSERT `WITH CHECK` and the UPDATE `USING`/`WITH CHECK` must require `not match_is_kicked_off(match_id)`, or an upsert could create a prediction after kickoff. The `match_is_kicked_off()` helper evaluates `now()` per-row at query time (no caching path).
- **Use the session SSR client only** (`createClient` from `src/lib/supabase.ts`). Never import `src/lib/supabase-admin.ts` in any predictions path — service-role bypasses RLS and would defeat blindness.

## Phase 1: Migration — predictions schema, RLS & participant read

### Overview

Create the `predictions` table, the `match_is_kicked_off()` helper, the predictions RLS policies (blindness SELECT + locked owner writes), and open participant SELECT on `matches`/`tournaments`. Regenerate TS types.

### Changes Required:

#### 1. New migration file

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_predictions_with_blindness.sql` (create via `npm run db:migration:new predictions_with_blindness`)

**Intent**: Add the predictions table and all DB-layer enforcement for FR-011–FR-015/FR-017, and widen read access so participants can see fixtures.

**Contract**:
- Table `public.predictions`:
  - `id uuid primary key default gen_random_uuid()`
  - `predictor_id uuid not null references public.profiles(id) on delete cascade`
  - `match_id uuid not null references public.matches(id) on delete cascade`
  - `home_goals smallint not null`, `away_goals smallint not null`
  - `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`
  - `unique (predictor_id, match_id)`
  - `check (home_goals >= 0 and home_goals <= 99)`, `check (away_goals >= 0 and away_goals <= 99)`
  - index on `(match_id)` and on `(predictor_id)` to support the policy subquery and the participant's own-rows fetch
  - `updated_at` trigger using existing `public.set_updated_at()`
- Helper `public.match_is_kicked_off(p_match_id uuid) returns boolean`, `language sql stable security definer set search_path = ''`, body: `select exists (select 1 from public.matches m where m.id = p_match_id and m.kickoff_time <= now())`.
- `alter table public.predictions enable row level security;`
- Policies (`to authenticated`):
  - `predictions_select USING (predictor_id = auth.uid() OR public.match_is_kicked_off(match_id))` — **no `is_admin()` branch.**
  - `predictions_insert WITH CHECK (predictor_id = auth.uid() AND NOT public.match_is_kicked_off(match_id))`
  - `predictions_update USING (predictor_id = auth.uid() AND NOT public.match_is_kicked_off(match_id)) WITH CHECK (predictor_id = auth.uid() AND NOT public.match_is_kicked_off(match_id))`
  - (No DELETE policy — predictions are not user-deletable in S-03.)
- Widen reads (new SELECT policies, admin write policies unchanged):
  - `matches_select_all` → `for select to authenticated using (true)` (replaces/augments the admin-only select; keep a single SELECT policy that is `using (true)` since admins are authenticated too).
  - `tournaments_select_all` → `for select to authenticated using (true)`.
- `comment on table public.predictions` documenting the blindness invariant and the kickoff lock.

Note on replacing existing admin-only SELECT: forward-only migrations — `drop policy matches_select on public.matches;` then create the `using (true)` SELECT policy (same for `tournaments_select`). Do not edit prior migration files.

#### 2. Regenerated DB types

**File**: `src/db/database.types.ts`

**Intent**: Reflect the new table + helper so the typed client and tests compile.

**Contract**: Run `npm run db:reset` then `npm run db:types`; commit the regenerated file. Must include `predictions` `Row`/`Insert`/`Update` and the `match_is_kicked_off` function entry.

### Success Criteria:

#### Automated Verification:
- Migration applies cleanly: `npm run db:reset`
- Types regenerate without diff drift on a second run: `npm run db:types` (no further changes)
- Type checking passes: `npx astro sync && npm run lint`
- Build passes: `npm run build`

#### Manual Verification:
- In Supabase Studio, `predictions` has RLS enabled with exactly the four expected policies and no `is_admin()` in the SELECT policy.
- A manual SQL check confirms `match_is_kicked_off()` returns true only for past-kickoff matches.

**Implementation Note**: After Phase 1 automated checks pass, pause for human confirmation before Phase 2.

---

## Phase 2: Prediction schema + upsert Action

### Overview

Add the shared zod schema and a single `predictions.upsert` Astro Action that writes via the session client with defense-in-depth kickoff checks.

### Changes Required:

#### 1. Shared prediction schema

**File**: `src/lib/schemas/prediction.ts`

**Intent**: One zod schema shared by the form (`zodResolver`) and the Action (`input`), matching the `matchFormSchema` no-transform style.

**Contract**: `predictionUpsertSchema = z.object({ matchId: z.uuid(), homeGoals: z.coerce.number().int().min(0).max(99), awayGoals: z.coerce.number().int().min(0).max(99) })`; export `type PredictionUpsertInput = z.infer<typeof predictionUpsertSchema>`. (Range mirrors the DB CHECK.)

#### 2. `predictions` action namespace

**File**: `src/actions/index.ts`

**Intent**: Add `predictions: { upsert: defineAction({...}) }` that performs an authenticated, kickoff-locked upsert on the session client.

**Contract**:
- `accept: "json"`, `input: predictionUpsertSchema`.
- Handler: require an authenticated user from `context.locals.user` (throw `UNAUTHORIZED` if absent); build the **session** client via `createClient(context.request.headers, context.cookies)` (NOT `adminClient`/service-role).
- App pre-check (friendly error): fetch the match `kickoff_time`; if missing → `NOT_FOUND`; if `new Date(kickoff).getTime() <= Date.now()` → `ActionError({ code: "FORBIDDEN", message: <kicked-off> })` (mirror `KICKED_OFF` usage at `src/actions/index.ts:223-237`).
- Upsert: `.from("predictions").upsert({ predictor_id: user.id, match_id, home_goals, away_goals }, { onConflict: "predictor_id,match_id" }).select("id")`.
- Zero-row guard: if `data.length === 0` after no error → `FORBIDDEN` (the RLS lock fired between read and write), mirroring `src/actions/index.ts:248-252`.
- Errors via existing `internalError()` / `inputError()` helpers.

#### 3. (If needed) DTO/type export

**File**: `src/types.ts` or co-located in the schema file

**Intent**: A `Prediction` view-model for the UI (camelCase) if the page maps rows.

**Contract**: Minimal `{ matchId, homeGoals, awayGoals }` shape for island props; keep generated row types in `database.types.ts`.

### Success Criteria:

#### Automated Verification:
- Lint + types pass: `npm run lint`
- Build passes: `npm run build`
- `npm test` passes (no regressions in existing unit tests)

#### Manual Verification:
- Calling `actions.predictions.upsert` from a temporary harness or the UI creates then updates a single row (no duplicates).
- Attempting an upsert on a past-kickoff match returns a `FORBIDDEN` action error.

**Implementation Note**: Pause for human confirmation after Phase 2 automated checks.

---

## Phase 3: Participant predictions UI

### Overview

Add the `/predictions` SSR page and the React island for viewing matches and entering/editing predictions, plus a dashboard entry point.

### Changes Required:

#### 1. Predictions page (SSR)

**File**: `src/pages/predictions/index.astro`

**Intent**: Server-fetch the match list + the current user's own predictions under RLS, then hand serializable rows to a `client:load` island. Mirrors `src/pages/admin/index.astro:11-91`.

**Contract**: Build session client; read the single tournament (`id, name, time_zone`); read `matches` (`id, home_team, away_team, kickoff_time` ordered by `kickoff_time asc`); read `predictions` for the current user (`match_id, home_goals, away_goals`). Map each match to `{ id, homeTeam, awayTeam, kickoffLocal: formatInZone(utc, zone), isPast, prediction?: {homeGoals, awayGoals} }`. Pass rows + `timeZone` to the island. Handle the no-tournament/empty states gracefully.

#### 2. Prediction list + form island

**File**: `src/components/predictions/PredictionList.tsx` and `src/components/predictions/PredictionForm.tsx`

**Intent**: Render matches; for not-past matches show an editable score form; for past matches show a "Locked" state (and, after kickoff, the values are simply whatever the page fetched). Form follows the `TournamentForm.tsx:25-51` RHF + `zodResolver` + `actions.predictions.upsert` + `isInputError` pattern.

**Contract**: `PredictionForm` uses `useForm({ resolver: zodResolver(predictionUpsertSchema), defaultValues: { matchId, homeGoals, awayGoals } })`; submit calls `actions.predictions.upsert(values)`, maps `isInputError` → `form.setError`, else `setServerError`; on success reflect the saved values (reload or local state update). Two numeric `Input`s (home/away). `PredictionList` maps rows, gating the form on `!isPast` and rendering a lock indicator otherwise (reuse the `isPast` + `MatchList.tsx:39-45` lock convention).

#### 3. Dashboard entry point

**File**: `src/pages/dashboard.astro`

**Intent**: Add a link to `/predictions` for all authenticated users (alongside the existing admin links).

**Contract**: Anchor to `/predictions` visible to every signed-in user (not admin-gated).

#### 4. (If needed) shadcn primitive

**Intent**: Numeric `input` already exists; only add a primitive if the chosen UX needs it.

**Contract**: If required, `npx shadcn@latest add <name>` (do not hand-author `src/components/ui/`).

### Success Criteria:

#### Automated Verification:
- Lint + types pass: `npm run lint`
- Build passes: `npm run build`

#### Manual Verification:
- As a participant, `/predictions` lists all matches in kickoff order with correct local times.
- Entering and saving a score persists; returning shows the saved score; editing before kickoff updates it.
- A past-kickoff match shows the locked state and offers no editable form.
- `/predictions` redirects to `/auth/signin` when logged out (middleware default-deny).
- Dashboard shows the predictions link for a non-admin participant.

**Implementation Note**: Pause for human confirmation after Phase 3.

---

## Phase 4: Blindness RLS test + CI job

### Overview

Add the live-DB integration test that proves FR-015, and a CI job that boots Supabase so the test runs on every PR.

### Changes Required:

#### 1. Predictions RLS test

**File**: `src/db/predictions.rls.test.ts`

**Intent**: Prove the blindness invariant and the write-lock at the DB layer. Mirror `src/db/matches.rls.test.ts` but create a SECOND participant to test cross-participant visibility.

**Contract**: `describe.skipIf(!dbConfigured)`. Setup (service-role): create participant A and participant B; admin seeds a tournament + one future match and one past match. Assertions:
- Owner read: A reads A's own pre-kickoff prediction → 1 row.
- **Cross-participant blindness**: B reads A's pre-kickoff prediction (`select ... eq("match_id", futureMatch)` filtered to A's row) → **0 rows**.
- **Admin blindness**: admin session reads A's pre-kickoff prediction → **0 rows**.
- Post-kickoff reveal: for a prediction on the past match, B and admin both read it → 1 row.
- Write lock: A upserting a prediction on the past match → 0 rows affected / RLS denial; A on the future match → succeeds.
- Uniqueness: A inserting a second row for the same match conflicts (or upsert updates in place).

#### 2. CI RLS job

**File**: `.github/workflows/ci.yml`

**Intent**: Add an `rls` job that starts local Supabase and runs the RLS tests with the required env, so blindness is continuously enforced.

**Contract**: New job (parallel to `ci`, or gating `deploy`) that: checks out, sets up Node 22, installs the Supabase CLI (`supabase/setup-cli`), runs `npx supabase start`, applies migrations (`supabase db reset` is implied by start with migrations), exports `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` from `npx supabase status -o env`, seeds the admin (the local seed needs `ADMIN_EMAIL`/`ADMIN_PASSWORD`; generate `supabase/seed.sql` via `node scripts/seed-template.mjs` with CI env), then `npm test -- rls`. Add `rls` to `deploy.needs`. Keep `describe.skipIf` so local `npm test` without env still skips.

### Success Criteria:

#### Automated Verification:
- Locally with the documented env vars, the blindness test passes: `SUPABASE_DB_URL=... SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... npm test -- predictions.rls`
- The CI `rls` job is green on the PR (the blindness assertions actually execute, not skip).
- Default `npm test` (no env) still passes by skipping the live suite.

#### Manual Verification:
- Review the CI run log to confirm the `predictions RLS` describe block ran (not skipped) and all cases passed.
- Two-account manual check in the running app: participant B never sees participant A's pre-kickoff score; after kickoff, B sees it.

**Implementation Note**: This phase closes the integrity guarantee — do not archive the change until the CI `rls` job has run green at least once.

---

## Testing Strategy

### Unit Tests:
- Prediction zod schema accepts valid scores, rejects negatives/over-cap/non-integers (can run in default `npm test`).

### Integration Tests (live DB, Phase 4):
- Blindness: cross-participant and admin both get 0 rows pre-kickoff; everyone gets the row post-kickoff.
- Write-lock: upsert denied/zero-rows after kickoff; allowed before.
- Uniqueness: one row per `(predictor, match)`.

### Manual Testing Steps:
1. Sign in as participant A, predict a future match, confirm it shows on reload.
2. Sign in as participant B, open the same match pre-kickoff — A's score is not visible anywhere.
3. Sign in as admin, open the same match pre-kickoff — A's score is not visible.
4. Wait for (or seed) a past kickoff; confirm the match is locked for editing and all predictions are now visible to B and admin.
5. Edit A's prediction before kickoff and confirm the single row updates (no duplicate).

## Performance Considerations

Negligible at MVP scale (5–20 users, one tournament). The policy subquery is covered by the `(match_id)` index on `predictions` and the existing kickoff index on `matches`; `match_is_kicked_off()` is `stable` so it is evaluated efficiently per statement.

## Migration Notes

Forward-only migration (no edits to applied files). Dropping and recreating the `matches`/`tournaments` SELECT policies to widen them is additive to behavior (admins still satisfy `using (true)`); no data change. Regenerate and commit `src/db/database.types.ts`. Production migration is a manual operator step (`npx supabase db push`) per AGENTS.md; no Supabase rollback is coupled to the Worker.

## References

- Research: `context/changes/prediction-with-blindness/research.md`
- Kickoff-lock + zero-row guard precedent: `src/actions/index.ts:215-254`
- Helper-function precedent: `supabase/migrations/20260528232000_identity_boundary.sql:82-93`
- Per-user policy precedent: `supabase/migrations/20260528232000_identity_boundary.sql:163-184`
- Matches RLS test to mirror: `src/db/matches.rls.test.ts`
- Page pattern: `src/pages/admin/index.astro:11-91`; form pattern: `src/components/admin/TournamentForm.tsx:25-51`
- Shared-schema pattern: `src/lib/schemas/match.ts`
- CI workflow: `.github/workflows/ci.yml`
- Roadmap slice S-03: `context/foundation/roadmap.md`; lessons: `context/foundation/lessons.md`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Migration — predictions schema, RLS & participant read

#### Automated
- [x] 1.1 Migration applies cleanly: `npm run db:reset` — 3872610
- [x] 1.2 Types regenerate with no drift on second run: `npm run db:types` — 3872610
- [x] 1.3 Type checking passes: `npx astro sync && npm run lint` — 3872610
- [x] 1.4 Build passes: `npm run build` — 3872610

#### Manual
- [x] 1.5 `predictions` RLS verified in Studio: four policies, no `is_admin()` in SELECT — 3872610
- [x] 1.6 `match_is_kicked_off()` returns true only for past-kickoff matches — 3872610

### Phase 2: Prediction schema + upsert Action

#### Automated
- [x] 2.1 Lint + types pass: `npm run lint`
- [x] 2.2 Build passes: `npm run build`
- [x] 2.3 `npm test` passes (no regressions)

#### Manual
- [ ] 2.4 Upsert creates then updates a single row (no duplicates)
- [ ] 2.5 Upsert on a past-kickoff match returns `FORBIDDEN`

### Phase 3: Participant predictions UI

#### Automated
- [ ] 3.1 Lint + types pass: `npm run lint`
- [ ] 3.2 Build passes: `npm run build`

#### Manual
- [ ] 3.3 `/predictions` lists matches in kickoff order with correct local times
- [ ] 3.4 Save/edit before kickoff persists; single row updates on edit
- [ ] 3.5 Past-kickoff match shows locked state, no editable form
- [ ] 3.6 `/predictions` redirects to `/auth/signin` when logged out
- [ ] 3.7 Dashboard shows the predictions link for a non-admin participant

### Phase 4: Blindness RLS test + CI job

#### Automated
- [ ] 4.1 Local blindness test passes: `... npm test -- predictions.rls`
- [ ] 4.2 CI `rls` job is green and the suite runs (not skipped)
- [ ] 4.3 Default `npm test` (no env) still passes by skipping the live suite

#### Manual
- [ ] 4.4 CI log confirms the predictions RLS block executed and all cases passed
- [ ] 4.5 Two-account manual check confirms blindness pre-kickoff and reveal post-kickoff
