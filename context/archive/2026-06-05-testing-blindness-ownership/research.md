---
date: 2026-06-05T23:45:00+02:00
researcher: mimazu
git_commit: 12a19af040f9d33fca69e585d0e29498f7f9e1c8
branch: main
repository: braveai-prj
topic: "Blindness & ownership at the DB boundary (test rollout Phase 2 — Risks #1, #3, #5)"
tags: [research, codebase, rls, predictions, service-role, supabase, testing]
status: complete
last_updated: 2026-06-05
last_updated_by: mimazu
---

# Research: Blindness & ownership at the DB boundary (test rollout Phase 2)

**Date**: 2026-06-05T23:45:00+02:00
**Researcher**: mimazu
**Git Commit**: 12a19af040f9d33fca69e585d0e29498f7f9e1c8
**Branch**: main
**Repository**: braveai-prj

## Research Question

Ground the integration tests for test-plan Phase 2 "Blindness & ownership at the DB boundary" against the live codebase, covering:

- **#1** — a participant's/admin's prediction is visible to others before kickoff (pre-kickoff leak).
- **#3** — one participant creates/edits/deletes another's prediction (IDOR / ownership).
- **#5** — service-role client or misscoped server action bypasses RLS and exposes predictions.

For each, where is the invariant enforced, what is the cheapest layer that gives real signal, and which scenarios are already covered vs missing.

## Summary

All three invariants are enforced **at the database boundary** by RLS policies in one migration, plus one server-side owner assignment. The cheapest real-signal layer is **RLS integration tests against the live local Supabase** (test-plan §6.2 convention), extending the existing `src/db/predictions.rls.test.ts` foothold. Key findings:

- **#1 (blindness)** — `predictions_select` `USING (predictor_id = auth.uid() OR public.match_is_kicked_off(match_id))`. The helper `match_is_kicked_off` is a `SECURITY DEFINER` SQL function comparing `matches.kickoff_time <= now()` (Postgres clock, per-row at fetch). **There is deliberately NO `is_admin()` branch** — the admin is blind too (FR-017). Already covered: owner/peer/admin pre-kickoff + post-kickoff reveal. **Gaps**: exact-kickoff boundary, unfiltered list query (`.eq("match_id", …)` without owner filter), anon/unauthenticated SELECT.
- **#3 (ownership/IDOR)** — single mutation path `predictions.upsert` sets `predictor_id: user.id` from the **session** (`context.locals.user`), never from client input (the zod schema has no owner field). RLS `INSERT`/`UPDATE` bind `predictor_id = auth.uid()`. No user DELETE policy exists. Spoofing is blocked at **both** layers. **Gaps**: no test where B attempts to INSERT with a spoofed `predictor_id = A`, UPDATE A's row, or DELETE A's row; no test of the `upsert` action with cross-user intent.
- **#5 (service-role blast radius)** — service-role client (`createAdminAuthClient`) reads its key only via `astro:env/server`, has **exactly 1 production importer** (`src/actions/index.ts`) with **2 auth-only call sites** (`createUser`, `deleteUser`). It **never** touches `predictions` in production. Per `lessons.md`, the isolation assertion must target **production reads / importer count**, not a raw `rg` across `src/` (test harnesses reference the key name and produce false positives).

The harness is well-established but **duplicated per file** (no shared module). A new test should follow the same ~50-line bootstrap: `freshClient(key)`, `signedInClient(email,pwd)`, service-role `auth.admin.createUser` for participants, seeded `admin@betcup.local` for admin, future/past kickoff fixtures, `describe.skipIf(!dbConfigured)`.

**Recommended scope for the change**: extend `src/db/predictions.rls.test.ts` with the missing IDOR/spoof and edge cases, plus a small isolation assertion for #5 (importer/reader count, not grep). The blindness happy/peer/admin paths are already proven — do not duplicate them.

## Detailed Findings

### #1 — Pre-kickoff blindness (RLS SELECT predicate)

All enforcement is in one migration; no later migration alters predictions RLS.

- Predictions table + RLS — `supabase/migrations/20260604184657_predictions_with_blindness.sql:27-92`.
- Owner column: `predictor_id uuid not null references public.profiles(id)` (`:29`).
- SELECT policy (`:78-81`):

```78:81:supabase/migrations/20260604184657_predictions_with_blindness.sql
create policy predictions_select on public.predictions
  for select
  to authenticated
  using (predictor_id = auth.uid() or public.match_is_kicked_off(match_id));
```

- Kickoff helper (`:60-71`) — `SECURITY DEFINER`, `stable`, `set search_path = ''`:

```60:71:supabase/migrations/20260604184657_predictions_with_blindness.sql
create function public.match_is_kicked_off(p_match_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select exists (
    select 1 from public.matches m
    where m.id = p_match_id and m.kickoff_time <= now()
  );
$$;
```

- Matches table + kickoff column — `public.matches`, `kickoff_time timestamptz not null` (`supabase/migrations/20260602180000_tournament_and_matches.sql:41-49`).
- **No admin exemption** — explicit design comment at `…predictions_with_blindness.sql:7-11`: predictions SELECT is the one per-user policy with NO `is_admin()` branch (contrast `profiles_select` at `20260528232000_identity_boundary.sql:166`, `match_results_*` at `20260605052647_results_scoring_leaderboard.sql:64-70`).
- Policy is scoped `to authenticated`; there is no `anon` policy, so unauthenticated SELECT is default-denied.
- Semantics: pre-kickoff (`kickoff_time > now()`) → only `predictor_id = auth.uid()` passes (owner-only). Post-kickoff (`kickoff_time <= now()`) → OR branch true for any authenticated user (world-visible to logged-in users).

Already covered in `src/db/predictions.rls.test.ts`: owner reads own pre-kickoff (`143-153`), B blind to A pre-kickoff (`155-164`), admin blind to A pre-kickoff — no exemption (`166-175`), reveal to B and admin post-kickoff (`177-199`).

### #3 — Ownership / IDOR (server action + RLS)

- **Single mutation path**: `predictions.upsert` action — `src/actions/index.ts:425-475`. No `src/pages/api/**` route touches predictions.
- Owner assigned from session, not client — `src/actions/index.ts:459-460` (`predictor_id: user.id`), with `user` from `sessionClient(context)` (`:91-100`) → `context.locals.user` set in middleware (`src/middleware.ts:43-52`).
- Input schema accepts no owner field — `src/lib/schemas/prediction.ts:14-18` (`matchId`, `homeGoals`, `awayGoals` only).
- RLS write policies bind owner to `auth.uid()` — INSERT `with check (predictor_id = auth.uid() and not match_is_kicked_off(match_id))` (`…predictions_with_blindness.sql:83-86`); UPDATE `using`+`with check` same (`:88-92`).
- **No DELETE policy** for predictions (`:74-75`) → user delete is default-denied. Predictions are removed only as an FK cascade when the admin deletes a participant (`participants.delete`, `src/actions/index.ts:230-263`).
- Identity chain (no separate participants table): `auth.users.id` = `auth.uid()` = `profiles.id` = `predictions.predictor_id` (`20260528232000_identity_boundary.sql:17-18`).

Spoof matrix (all blocked today): client owner field (no schema field + server sets `user.id`), direct PostgREST INSERT as victim (`WITH CHECK`), UPDATE victim row (`USING` → 0 rows), owner reassign on UPDATE (`WITH CHECK`), DELETE victim row (no policy).

### #5 — Service-role blast radius

- Definition — `src/lib/supabase-admin.ts`; key read via `astro:env/server` only (`:2`), guarded factory `createAdminAuthClient()` (`:23-33`).
- **Production importers: exactly 1** — `src/actions/index.ts:14`, with 2 auth-only call sites: `participants.create` → `auth.admin.createUser` (`~181-207`) and `participants.delete` → `auth.admin.deleteUser` (`~248-263`).
- Admin client **never** calls `.from("predictions")` (or any per-user table read) in production. Note: `adminClient()` in `src/actions/index.ts:74-80` is a misleading name — it is the **RLS-respecting session SSR client** after `requireAdmin`, NOT the service-role client.
- Env declaration — `astro.config.mjs:21-24` (`envField.string({ context: "server", access: "secret", optional: true })`); `.env.example:4-8`; CI maps it at `.github/workflows/ci.yml:113`.
- Per `lessons.md`, isolation must be asserted against **production reads / importer count**, excluding test files. Test/harness files that reference the key name (must be excluded from any grep-based check): `src/db/{matches,predictions,history,results-scoring}.rls.test.ts`, `src/actions/{participants,account}.test.ts`, `test/stubs/astro-env-server.ts`.

### Test harness conventions (test-plan §6.2)

- No shared RLS helper — each `src/db/*.rls.test.ts` duplicates the bootstrap.
- Env from `process.env` (NOT the `astro:env` stub, which is only for action tests): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` — `src/db/predictions.rls.test.ts:33-39`.
- Skip gate: `const dbConfigured = Boolean(process.env.SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY)` → `describe.skipIf(!dbConfigured)(…)`.
- Clients: `freshClient(key)` (`:46-50`), `signedInClient(email,pwd)` (anon key + `signInWithPassword`, `:52-57`). Three roles in `beforeAll`: `service` (service-role), `admin` (signed-in seed admin), `participantA/B` (created via `service.auth.admin.createUser`, then signed in) — `:71-92`.
- Admin is NOT created in tests — it is the seeded `admin@betcup.local` (`handle_new_user` trigger grants `admin` only when email matches `app.admin_email`, `20260604153800_participant_username.sql:60-66`). Participants get `participant` role only.
- Fixtures: future = `now + 7d`, past = `now - 1h` (`:102-106`); `seedMatch` via admin session (`:133-141`). Pre-kickoff predictions seeded via participant session (real INSERT policy); post-kickoff predictions seeded via `service` (bypasses INSERT lock) — `:108-123`.
- Teardown: delete tournament (FK cascade) + `auth.admin.deleteUser` per user (`:126-130`).
- Assertion style: blindness/UPDATE-lock → `expect(error).toBeNull(); expect(data ?? []).toHaveLength(0)`; INSERT WITH CHECK violation → `expect(error).not.toBeNull()`; success → `expect(error).toBeNull(); expect(data).toHaveLength(1)`. RLS tests never assert Postgres `error.code`.
- Run: `npm test -- predictions.rls` with the four env vars exported and `npm run db:start` first. CI `rls` job: `.github/workflows/ci.yml:86-116` (`npm test -- rls`). `vitest.config.ts` has no setupFiles/dotenv — env must be in the shell.

## Code References

- `supabase/migrations/20260604184657_predictions_with_blindness.sql:27-92` — predictions table, RLS policies, `match_is_kicked_off`; no `is_admin()` branch.
- `supabase/migrations/20260602180000_tournament_and_matches.sql:41-49` — matches table, `kickoff_time` column.
- `src/actions/index.ts:425-475` — `predictions.upsert` (owner from session at `:459-460`).
- `src/actions/index.ts:91-100` — `sessionClient` (RLS session client + `context.locals.user`).
- `src/actions/index.ts:74-80` — `adminClient()` = RLS session client (NOT service-role; naming trap).
- `src/lib/schemas/prediction.ts:14-18` — upsert input schema (no owner field).
- `src/middleware.ts:43-52` — `context.locals.user` from session cookies.
- `src/lib/supabase-admin.ts:2,23-33` — service-role client; `astro:env/server` key read.
- `src/db/predictions.rls.test.ts` — existing blindness/write-lock foothold (conventions + covered cases).
- `astro.config.mjs:21-24`, `.env.example:4-8`, `.github/workflows/ci.yml:86-116` — env declaration + CI rls job.

## Architecture Insights

- **Defense in depth on ownership**: the server action sets the owner from the session AND RLS independently binds `predictor_id = auth.uid()`. Either layer alone blocks IDOR; the test should prove the **DB layer** directly (raw client with a spoofed `predictor_id`) so the guarantee survives a future action refactor.
- **Blindness is a SQL invariant, not a UI one** (PRD FR-015 Socratic note). The cheapest real signal is a row-fetch as a non-owner, exactly what `predictions.rls.test.ts` does. Asserting UI state would be the anti-pattern called out in test-plan §2 (#1 row).
- **Admin-not-exempt is load-bearing and unusual** — it is the single per-user policy without `is_admin()`. A regression here (someone "helpfully" adding an admin bypass) is a top risk; the admin-blindness test is the guard and already exists.
- **Service-role single-importer is the real invariant** for #5, not the literal secret string. The blast radius grows only if a second importer appears or `.from("predictions")` is chained off the admin client.
- **`now()` per-row evaluation** means the kickoff boundary is genuine — a test should cross it for real (e.g. a match with kickoff a few seconds out, or rely on the −1h/+7d split) rather than freezing time (test-plan §2 #4 anti-pattern).

## Historical Context (from prior changes)

- `context/foundation/test-plan.md:44-48,76-81,93,160-168` — Phase 2 definition, Risk Response Guidance for #1/#3/#5, §6.2 RLS cookbook (TBD until this phase ships).
- `context/foundation/lessons.md:12-17` — "Isolation criteria should target production reads, not literal grep across src/": phrase secret-isolation criteria against production reads (`rg --glob '!*.test.*'`) or importer/reader count. Directly governs the #5 assertion.
- `context/changes/testing-scoring/` — Phase 1 (scoring/ranking), the prior completed rollout phase; sibling RLS file `src/db/results-scoring.rls.test.ts` follows the same harness with an added `pg` client (`@vitest-environment node`).
- `context/changes/testing-blindness-ownership/change.md` — this change's intent (the three risk responses).

## Related Research

- No prior `research.md` exists for blindness/ownership. Sibling test artifacts: `src/db/{predictions,matches,history,results-scoring}.rls.test.ts` are the working references.

## Open Questions

1. **Edit scope** — extend `src/db/predictions.rls.test.ts` (recommended; blindness foothold already there) vs a new `predictions-ownership.rls.test.ts` sibling? Leaning extend, to keep one source of truth for the predictions policy.
2. **#5 assertion mechanism** — a shell/`rg` importer-count check wired as a test (Vitest reading the file) vs a lightweight static assertion. Either must follow `lessons.md` (exclude `*.test.*`, assert importer/reader count = 1). Decide in planning.
3. **Exact-kickoff boundary** — is a real "kicks off in N seconds" fixture worth the flake risk, or is the −1h/+7d split sufficient signal for #1? The test-plan flags frozen-time as the anti-pattern but does not require sub-second precision.
4. **Anon SELECT** — worth one negative test that an unauthenticated client gets 0 rows / denial, given the policy is `to authenticated` only? Cheap; closes a documented gap.
