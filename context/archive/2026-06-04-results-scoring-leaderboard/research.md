---
date: 2026-06-04T22:45:00+02:00
researcher: mimazu
git_commit: 2b6c8ec244c836973d943caf0991fc099ec8c5a3
branch: feature/S-04_results-scoring-leaderboard
repository: bet-cup
topic: "S-04 results-scoring-leaderboard: admin enters/corrects a result, scoring computes (FR-018), post-kickoff predictions become visible (FR-016), leaderboard ranks participants (FR-020)"
tags: [research, codebase, scoring, leaderboard, results, rls, predictions, matches, astro-actions]
status: complete
last_updated: 2026-06-04
last_updated_by: mimazu
---

# Research: S-04 results-scoring-leaderboard (north star)

**Date**: 2026-06-04T22:45:00+02:00
**Researcher**: mimazu
**Git Commit**: 2b6c8ec244c836973d943caf0991fc099ec8c5a3
**Branch**: feature/S-04_results-scoring-leaderboard
**Repository**: bet-cup

## Research Question

Ground the implementation of roadmap slice **S-04** (`context/foundation/roadmap.md:122-134`): the admin views a kickoff-passed match with no result, enters home/away scores and confirms; every participant's prediction is scored per FR-018 (3/2/1/0); post-kickoff predictions become visible to all (FR-016); the leaderboard ranks all participants by total points (FR-020), tie-broken by exact-score count then alphabetically; and re-entering a result recomputes all affected scores. PRD refs: US-02, FR-009, FR-010, FR-016, FR-018, FR-019, FR-020.

## Summary

S-04 is **almost entirely greenfield at the data/logic layer** but sits on a mature, consistent set of conventions from F-01/S-01/S-02/S-03. The concrete state:

- **What exists and must be preserved.** FR-016 (post-kickoff visibility) is **already shipped** — it flips on `kickoff_time <= now()`, *not* on result entry, via the `predictions_select` RLS policy + `match_is_kicked_off()` helper (`supabase/migrations/20260604184657_predictions_with_blindness.sql:60-81`). S-04 must **not** regress FR-015 blindness (no `is_admin()` branch on prediction SELECT) and must not tie visibility to result presence.
- **What's missing (S-04's actual work).** No result columns on `matches`; no points columns/view; no leaderboard query/page; no result-entry Action/UI; no scoring module. All explicitly deferred to S-04 in prior plans.
- **The one real fork.** Scoring strategy — a read-time **Postgres view** vs. a **stored/materialized points column** written on result entry (`context/foundation/roadmap.md:130-131`). Still undecided; this is the central `/10x-plan` decision.
- **A concrete blocker to design around.** The existing `matches_update` RLS policy is `USING (is_admin() AND kickoff_time > now())` — it **blocks every post-kickoff UPDATE on a match row** (`supabase/migrations/20260602180000_tournament_and_matches.sql:103-107`). Result entry happens *after* kickoff, so storing results on the `matches` row needs a new/split policy (a separate result column path, or a distinct `results` table/RPC).
- **Established patterns to clone.** Mutations are **Astro Actions** (`src/actions/index.ts`), never new `src/pages/api/*` routes. Forms are RHF + `zodResolver` + shared `src/lib/schemas/*` + `actions.*` + `window.location.reload()`. Admin gating is via middleware `ADMIN_ROUTES`. Leaderboard identity reads **must** use the `profiles_public` view (authenticated-only), never `profiles`.

## Detailed Findings

### Data layer — current schema

**`matches`** (`supabase/migrations/20260602180000_tournament_and_matches.sql:41-49`): `id`, `tournament_id` (FK→tournaments, cascade), `home_team`, `away_team`, `kickoff_time timestamptz NOT NULL`, `created_at`, `updated_at`. Index on `(tournament_id, kickoff_time)`. **No result columns** — explicitly deferred (`:15`, `:52`).

**`predictions`** (`supabase/migrations/20260604184657_predictions_with_blindness.sql:27-38`): `id`, `predictor_id` (FK→`profiles.id`, cascade), `match_id` (FK→`matches.id`, cascade), `home_goals smallint`, `away_goals smallint`, timestamps. `UNIQUE (predictor_id, match_id)` (one prediction per participant per match), `CHECK` 0..99 on each goal field. Indexes on `match_id` and `predictor_id`. **No points/result columns** — deferred to S-04 (`:25-26`).

**`profiles`** (`supabase/migrations/20260528232000_identity_boundary.sql:17-23` + `20260604153800_participant_username.sql`): `id` (PK→`auth.users`), `display_name NOT NULL`, `legal_name`, `username NOT NULL UNIQUE(lower)`, timestamps. **No `role` column** — roles live in a separate `user_roles` table (enum `user_role` = `admin|participant`; admin holds *both* rows per FR-017).

**`profiles_public` view** (`20260528232000_identity_boundary.sql:64-68`): `SELECT id, display_name, created_at, updated_at FROM profiles`, `security_invoker = false`. **Anon SELECT was revoked** (`20260601180000_revoke_profiles_public_anon.sql:7`) → authenticated-only. This is the **canonical non-admin identity read path** — F-01's plan mandates the S-04 leaderboard query `profiles_public`, not `profiles` (`context/archive/2026-05-28-identity-boundary/plan.md:77`). Note it exposes `display_name` (used by the FR-020 tie-break) but **not `username`** (`context/archive/2026-06-03-admin-creates-participants/reviews/impl-review.md:85`).

**Generated types**: `src/db/database.types.ts` (committed). Regenerate via `npm run db:types` (`package.json:19`); ESLint/Prettier-ignored. Imported as `import type { Database }` into `src/lib/supabase.ts:5`, `supabase-admin.ts:3`, `actions/index.ts:4`, and the RLS tests.

### RLS — what's live and the post-kickoff UPDATE blocker

**Predictions blindness (preserve verbatim)** — `supabase/migrations/20260604184657_predictions_with_blindness.sql:78-92`:
- `predictions_select USING (predictor_id = auth.uid() OR public.match_is_kicked_off(match_id))` — **no `is_admin()` branch** (admin is blind pre-kickoff, FR-017). This single policy delivers FR-015 (pre-kickoff hide) *and* FR-016 (post-kickoff reveal).
- `predictions_insert` / `predictions_update`: both gated on `predictor_id = auth.uid() AND NOT match_is_kicked_off(match_id)`. No DELETE policy.

**`match_is_kicked_off(p_match_id)`** (`:60-71`): `language sql stable security definer set search_path = ''`; body `select exists(select 1 from matches m where m.id = p_match_id and m.kickoff_time <= now())`. `now()` evaluates per-row at query time.

**Matches** — `matches_select_all USING (true)` (widened in S-03, `:105-110`); `matches_insert/delete USING is_admin()`; and the blocker:

```103:107:supabase/migrations/20260602180000_tournament_and_matches.sql
create policy matches_update on public.matches
  for update
  to authenticated
  using (public.is_admin() and kickoff_time > now())
  with check (public.is_admin());
```

This is the FR-008 pre-kickoff fixture-edit lock. **Result entry is post-kickoff**, so writing `home_score`/`away_score` onto the `matches` row is currently blocked by this `USING` clause. Design options for `/10x-plan`: (a) a separate result-write policy scoped to `is_admin()` (no time clause, or `kickoff_time <= now()`), carefully composed with the existing fixture-edit policy; (b) a dedicated `results` table with its own admin RLS; (c) a `SECURITY DEFINER` RPC for result upsert. `is_admin()` is defined at `20260528232000_identity_boundary.sql:82-93` (matches `auth.uid()` against `user_roles`).

### Scoring & leaderboard — no precedent, one fork

No scoring/leaderboard/results code exists under `src/` (grep confirms only migration comments + PRD/roadmap refs). `src/lib/services/` is documented in AGENTS.md but **does not exist yet**; business logic currently lives in Actions + pure `src/lib/*` helpers + SSR page frontmatter.

**The fork** (`context/foundation/roadmap.md:130-131`): Postgres view computing points on read (always-correct, never stale, more read cost) vs. a stored points column written on result entry/correction (faster reads, must invalidate on every correction). FR-010 (re-entry recomputes all affected scores) and the "leaderboard updates immediately" outcome are satisfied trivially by a view; the stored-column path needs explicit recompute-on-correction logic.

**FR-018 rule** (`context/foundation/prd.md:112`, business logic `:127-129`): 3 = exact score; else 2 = correct goal-difference *and* correct outcome (winner/draw); else 1 = correct outcome only; else 0. FR-019: no prediction → 0 for that match. The roadmap mandates an **exhaustive 4×4 grid unit test** to pin this (`context/foundation/roadmap.md:133`).

**FR-020 tie-break** (resolved, `prd.md:114-115`, `roadmap.md:132`): total points → count of exact-score (3-pt) predictions → alphabetical by `display_name` (case-insensitive ascending). All inputs available from `predictions` + `profiles_public`.

**Existing precedent to lean on**: `profiles_public` is the existing non-materialized view pattern. `match_is_kicked_off` is the existing `STABLE SECURITY DEFINER` SQL-function pattern (typed for `.rpc()` in generated types, though no `.rpc()` calls exist in `src/` yet). No materialized views anywhere.

### Mutation & UI patterns to clone

**Actions, not API routes.** All domain mutations live in `src/actions/index.ts` via `defineAction({ accept: "json", input: <zodSchema>, handler })`. Inventory: `participants.create` (service-role), `tournament.upsert`, `matches.add/bulkAdd/update`, `predictions.upsert` (session). API routes (`src/pages/api/`) are **auth-only** (`signin.ts`, `signout.ts`, both `export const prerender = false`). For S-04: add a new admin-only result Action (e.g. `matches.setResult` or a `results` namespace) using `adminClient`, mirroring `matches.update` but with an **inverted** kickoff check (allow when past).

**Action conventions**: `requireAdmin(locals)` (`src/actions/index.ts:56-61`); `adminClient`/`sessionClient` helpers; `internalError()` → generic 500 + server log (never raw DB errors to client); `inputError`/`isInputError` for field errors; **zero-row write → friendly `FORBIDDEN`** as the RLS-lock signal. Closest analog (`predictions.upsert`, `:289-328`) shows the match-fetch → app pre-check → upsert → zero-row guard sequence.

**Forms (RHF pattern)**: clone `src/components/predictions/PredictionForm.tsx:37-53` — `actions.<x>(values)` → on `isInputError` map field errors, else `setServerError`, on success `window.location.reload()`. `MatchForm.tsx:128-149` is the add/update variant.

**Lists**: `MatchList.tsx:44-68` renders matches with `isPast` → "Locked". For admin result entry, **invert the lock** (past matches become actionable). For predictions, `PredictionList.tsx:55-64` shows the read-only-after-kickoff pattern.

**Pages**: functional pages use `Layout` + `main.mx-auto.max-w-3xl.space-y-* p-6` (`src/pages/admin/index.astro:61-69`, `predictions/index.astro`). SSR loads data in frontmatter under RLS; islands hydrate `client:load`. `isPast` is computed server-side as `new Date(kickoff_time).getTime() <= Date.now()` (`predictions/index.astro:54-63`).

**shadcn primitives** (`src/components/ui/`): `button`, `calendar`, `form`, `input`, `label`, `popover`. **No `table`** — leaderboard either `npx shadcn@latest add table` (per AGENTS.md, don't hand-author) or reuse the raw `<table>` from `src/pages/admin/participants.astro:55-77`.

**Role gating**: middleware `ADMIN_ROUTES = ["/admin"]` (`src/middleware.ts:11`); pages check `Astro.locals.profile?.roles.includes("admin")` for nav (`dashboard.astro:26-41`); Actions re-check via `requireAdmin` (defense-in-depth, since `/_actions/*` are public). Leaderboard is **all-authenticated** (no admin gate, FR-020).

**Navigation**: no global nav; inline links. Natural S-04 entry points — leaderboard at `/leaderboard` linked from `dashboard.astro:17-24` (participant-facing); result entry as a new section/page off `/admin`.

### Time handling

`src/lib/time.ts` owns IANA wall-clock↔UTC conversion (`localToUtc`, `formatInZone`) for entry/display. "Has kickoff passed?" is **not** in `time.ts` — it's the repeated `utc.getTime() <= Date.now()` instant comparison (SSR pages, Actions, bulk-parse). DB source of truth for locks is Postgres `now()`. **S-02 lesson (impl-review F1)**: result-entry UI must format/compare using the **DB `tournaments.time_zone`**, not a hardcoded zone — a wrong zone shifts the kickoff boundary and could affect blindness.

### Testing

Vitest configured (`package.json:14`, `vitest.config.ts`, happy-dom). Two lanes: unit tests (pure utils/schemas, e.g. `src/lib/time.test.ts`) run in default CI; **live-DB RLS tests** (`src/db/*.rls.test.ts`) self-skip via `describe.skipIf(!dbConfigured)` and run in a dedicated CI **`rls` job** that does `supabase start` (`.github/workflows/ci.yml:86-116`). RLS tests use `@supabase/supabase-js` with a service-role setup client + per-role signed-in clients; they read `process.env.*` (not `astro:env/server`) via `test/stubs/`. For S-04: add `src/lib/scoring.test.ts` (the 4×4 FR-018 grid) as a pure unit test; if new result-write RLS is added, extend the `rls` job with a result/score RLS test (S-03 precedent for integrity-critical DB rules).

## Code References

- `supabase/migrations/20260602180000_tournament_and_matches.sql:41-49` — `matches` schema (no result columns)
- `supabase/migrations/20260602180000_tournament_and_matches.sql:103-107` — `matches_update` policy = the post-kickoff UPDATE blocker
- `supabase/migrations/20260604184657_predictions_with_blindness.sql:27-38` — `predictions` schema
- `supabase/migrations/20260604184657_predictions_with_blindness.sql:60-71` — `match_is_kicked_off()`
- `supabase/migrations/20260604184657_predictions_with_blindness.sql:78-92` — predictions RLS (FR-015/016 source of truth)
- `supabase/migrations/20260528232000_identity_boundary.sql:64-68` — `profiles_public` view (leaderboard identity read path)
- `supabase/migrations/20260528232000_identity_boundary.sql:82-93` — `is_admin()` helper
- `src/db/database.types.ts:37-46` / `:76-84` — generated `matches` / `predictions` rows
- `src/actions/index.ts:56-61` — `requireAdmin`; `:79-96` — session/admin client helpers; `:237-276` — `matches.update` (mirror, inverted); `:289-328` — `predictions.upsert` (closest analog)
- `src/lib/supabase-admin.ts:5-30` — service-role isolation (one importer; never reads per-user data)
- `src/components/predictions/PredictionForm.tsx:37-53` — RHF + Action submit pattern
- `src/components/admin/MatchList.tsx:44-68` — match list with `isPast` lock (invert for results)
- `src/pages/predictions/index.astro:54-63` — SSR `isPast` computation
- `src/pages/admin/participants.astro:55-77` — raw HTML table pattern (leaderboard fallback)
- `src/middleware.ts:11,68-77` — admin route gating
- `.github/workflows/ci.yml:86-116` — dedicated `rls` CI job
- `context/foundation/prd.md:112-116,127-129` — FR-018/019/020 scoring + tie-break
- `context/foundation/roadmap.md:122-134` — S-04 outcome, unknowns, risk

## Architecture Insights

- **RLS is the security source of truth; app checks are friendly mirrors.** The house pattern is: DB RLS policy (authoritative) + app-layer pre-check (nice error) + zero-row post-write guard (catch the lock). Replicate this for result writes.
- **Visibility is time-driven, not result-driven.** FR-016 already works off `kickoff_time <= now()`. Scoring/leaderboard are *orthogonal* to visibility — a match can be kicked-off-and-visible with no result yet (predictions shown, points pending). Don't couple them.
- **Service-role is radioactive and quarantined.** `src/lib/supabase-admin.ts` is the sole reader of the service-role key with exactly one importer (`participants.create`). S-04 must not widen this — all scoring/leaderboard/result reads ride session client + RLS. Misuse is the #1 FR-015 leak path.
- **A view-based scoring strategy aligns best with existing conventions** (read-time computation already used for visibility; `profiles_public` precedent; FR-010 recompute is free). The stored-column path trades that simplicity for read speed the MVP's scale (5–20 users, low QPS per PRD) doesn't need — but this is the `/10x-plan` call, not decided here.
- **One SELECT policy, `using (true)`, for matches/tournaments** — admins are authenticated too, so a single permissive read policy serves both roles (S-03 widening). Keep this shape if results land on `matches`.

## Historical Context (from prior changes)

- `context/archive/2026-05-28-identity-boundary/plan.md:77` — **mandate**: S-04 leaderboard MUST read `profiles_public`, not `profiles`. `:52` — per-domain tables (incl. scores) deferred to owning slices.
- `context/archive/2026-06-01-tournament-and-matches/plan.md:77-80,162` — `matches` carries no `home_score`/`away_score`; **S-04 adds them via its own migration**. `:159-160` — `matches_update` is the FR-008 pre-kickoff lock (the blocker above).
- `context/archive/2026-06-04-prediction-with-blindness/plan.md:48-49` — admin is NOT exempt from blindness (no `is_admin()` on prediction SELECT). `:80` — the FR-016 reveal is in this SELECT policy. `:237-241` — the blindness test contract to not regress.
- `context/archive/2026-06-03-admin-creates-participants/plan.md:62,147-149` — service-role isolation contract; `reviews/impl-review.md:85` — `profiles_public` lacks `username` (tie-break uses `display_name`, which is fine).
- `context/foundation/lessons.md:12-17` — phrase secret-isolation grep checks against production reads (exclude `*.test.*`). `:5-9` — declare benign support-file changes in the plan to avoid false scope-creep flags.
- Prior impl-review carry-overs S-04 should heed: bind result-entry timezone to DB `tournaments.time_zone` (S-02 F1); distinguish NOT_FOUND from lock on zero-row writes (S-02 F5); use `internalError()` not raw DB errors (S-02 F6); keep RLS tests in the dedicated CI `rls` job (S-02 plan-F1 / S-03).

## Related Research

- `context/archive/2026-06-04-prediction-with-blindness/research.md` — predictions/blindness RLS exploration (directly upstream of S-04).
- `context/archive/2026-06-01-tournament-and-matches/research.md` — matches/Actions/zod conventions.

## Open Questions

1. **Scoring strategy (the fork):** Postgres view (read-time) vs. stored points column (write-time). Recommendation leans view (matches conventions, free FR-010 recompute, MVP scale), but it's a `/10x-plan` decision. → owner: `/10x-plan`.
2. **Where do results live?** New columns on `matches` (needs a new post-kickoff-scoped RLS policy composed with the existing fixture-edit lock) vs. a dedicated `match_results` table (cleaner RLS separation: fixture-edit stays pre-kickoff, result-write is post-kickoff) vs. a `SECURITY DEFINER` upsert RPC. → owner: `/10x-plan`.
3. **Leaderboard shape:** a Postgres view (`leaderboard` joining predictions+results+profiles_public with the tie-break ordering) vs. app-side aggregation in the page frontmatter. The tie-break (exact-score count) is cleaner in SQL. → owner: `/10x-plan`.
4. **Does adding the result-write path need to widen `profiles_public`?** No — tie-break uses `display_name` which is already exposed. Confirm no username is shown on the leaderboard. → likely no action.
5. **`shadcn table` vs raw HTML table** for the leaderboard. → minor; `/10x-plan` or implementer's call.
