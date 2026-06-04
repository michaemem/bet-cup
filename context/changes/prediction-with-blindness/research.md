---
date: 2026-06-04T20:14:24+02:00
researcher: mimazu
git_commit: 3221b1b8efeb68ab6dab05f0d764d126415924ef
branch: feature/S-03_prediction-with-blindness
repository: braveai-prj
topic: "S-03 — Participant submits and edits predictions before kickoff (with the FR-015 blindness invariant)"
tags: [research, codebase, predictions, rls, blindness, kickoff-lock, supabase, astro-actions]
status: complete
last_updated: 2026-06-04
last_updated_by: mimazu
---

# Research: S-03 prediction-with-blindness

**Date**: 2026-06-04T20:14:24+02:00
**Researcher**: mimazu
**Git Commit**: 3221b1b8efeb68ab6dab05f0d764d126415924ef
**Branch**: feature/S-03_prediction-with-blindness
**Repository**: braveai-prj

## Research Question

How should the S-03 slice be built on top of the existing BetCup codebase? Specifically: what data model, RLS, server-action, test-harness, and UI conventions are already established by F-01/S-01/S-02 that the `predictions` feature must mirror — with the integrity-critical FR-015 "blindness" invariant (only the predictor, never another participant and never the admin, can read a prediction before that match's kickoff) enforced at the database (RLS) layer, not just the UI?

## Summary

The codebase is in a clean, consistent state with strong precedents for every piece S-03 needs. Key takeaways:

- **No `predictions` table exists yet** — it is greenfield in the next migration. S-02 explicitly deferred participant read access and the participant kickoff-lock to S-03.
- **Kickoff is already modeled correctly**: `matches.kickoff_time` is `timestamptz` (UTC at rest), with the tournament's IANA `time_zone` driving wall-clock entry/display. The exact lock S-03 needs already has a working precedent on `matches`: RLS `UPDATE USING (... kickoff_time > now())` + an app-layer pre-check + a zero-row post-write guard (race-proof).
- **The blindness rule is genuinely new surface.** Today `matches`/`tournaments` are admin-only (`is_admin()`), and the only per-user RLS is on `profiles`/`user_roles` via `auth.uid() = id`. S-03 introduces the first policy that combines `auth.uid()` ownership with a time predicate joined from `matches`, **and the admin is NOT exempt** (unlike `profiles_select`, which allows `is_admin()`).
- **Service-role isolation is the load-bearing security constraint.** `src/lib/supabase-admin.ts` is the only service-role reader and must NEVER touch `predictions`. All prediction reads/writes go through the session-bound SSR client so RLS enforces blindness.
- **The whole stack is already patterned**: Astro Actions in `src/actions/index.ts` (zod from `src/lib/schemas/`, defense-in-depth admin/lock checks), SSR reads inline in `.astro`, React islands with RHF + `zodResolver` + shadcn `Form` + `actions.*` + `isInputError`, default-deny middleware, and a live-DB Vitest RLS harness (`src/db/matches.rls.test.ts`) to copy.

The single highest-risk design decision is the **`predictions` SELECT policy**: it must let the owner always read their row, let everyone read once `kickoff_time < now()`, and never leak across the kickoff boundary. Because kickoff lives on `matches`, the policy needs a join/subquery to `matches.kickoff_time`.

## Detailed Findings

### Data model & migrations (centerpiece)

Four migrations exist under `supabase/migrations/`; none define `predictions`.

| File | Slice | Purpose |
|------|-------|---------|
| `20260528232000_identity_boundary.sql` | F-01 | enum `user_role`, `profiles`, `user_roles`, helpers, trigger, `profiles_public` view, RLS |
| `20260601180000_revoke_profiles_public_anon.sql` | F-01 fix | revoke `anon` SELECT on `profiles_public` |
| `20260602180000_tournament_and_matches.sql` | S-02 | `tournaments`, `matches`, admin-only RLS + kickoff lock |
| `20260604153800_participant_username.sql` | S-01 | `profiles.username` + updated `handle_new_user` |

**`matches` (the table S-03 joins to for kickoff):** columns `id uuid pk`, `tournament_id uuid not null references tournaments(id) on delete cascade`, `home_team text`, `away_team text`, `kickoff_time timestamptz not null`, `created_at`/`updated_at timestamptz default now()`. Index `matches_tournament_kickoff_idx on (tournament_id, kickoff_time)` (`supabase/migrations/20260602180000_tournament_and_matches.sql:54-55`) — explicitly sized to cover both the ordered list query and the `kickoff_time > now()` predicate.

- Migration table comment (`...:51-52`): *"…Admin-only RLS with a kickoff_time > now() UPDATE lock (FR-008); **S-03 opens participant read**. No result columns — scoring is S-04."*
- Kickoff timezone contract: `tournaments.time_zone` is an IANA zone name; wall-clock kickoffs are entered in that zone and converted to UTC for storage (`...:30-31`).
- **No CHECK constraints anywhere yet** — score/non-negative validation for predictions would be a new CHECK and/or app-layer zod.

**Role model:** roles live in a separate `public.user_roles` table (enum `user_role('admin'|'participant')`), not a column on `profiles`. The admin holds two rows (`participant` + `admin`, FR-017). Helper `public.is_admin()` (SECURITY DEFINER, stable) wraps `select exists(... where user_id = auth.uid() and role='admin')` (`...identity_boundary.sql:82-93`); siblings `is_participant()`, `current_user_roles()`.

**Generated types:** `src/db/database.types.ts` (committed), regenerated via `npm run db:types` (`package.json:19`). `matches.Row.kickoff_time` is typed `string` (ISO). A `predictions` entry must be added here after the migration via `db:reset` → `db:types` → commit.

### RLS policy precedents & the blindness gap

Existing policies (all verbatim in the migrations):

- `profiles_select` → `using (auth.uid() = id or public.is_admin())` (`...identity_boundary.sql:163-166`) — **per-user, but admin can see all.**
- `user_roles_select` → `using (auth.uid() = user_id or public.is_admin())` (`...:181-184`).
- `tournaments_*` and `matches_*` → admin-only via `public.is_admin()` (`...tournament_and_matches.sql:69-112`).
- `matches_update` → `using (public.is_admin() and kickoff_time > now()) with check (public.is_admin())` (`...:103-107`) — **the kickoff-lock precedent.**

What S-03 must add that has no precedent yet:
1. **Participant SELECT on `matches` and `tournaments`** (currently admin-only) so participants can see the fixture list.
2. **A `predictions` SELECT policy that is owner-OR-post-kickoff and does NOT exempt the admin.** Roadmap sketch: `predictor_id = auth.uid() OR <match kickoff_time> < now()`. Since `kickoff_time` is on `matches`, expect a subquery/join, e.g. `using (predictor_id = auth.uid() or exists (select 1 from matches m where m.id = predictions.match_id and m.kickoff_time < now()))`.
3. **Prediction INSERT/UPDATE policies** gated on `predictor_id = auth.uid()` AND the match not yet kicked off (mirror the `kickoff_time > now()` lock via the joined match).

`auth.jwt()` is used nowhere; `auth.uid()` and `now()` are the building blocks. `is_admin()` must NOT be added to the predictions SELECT policy — admin blindness is the whole point of FR-015/FR-017.

### Kickoff lock — the dual-layer pattern to replicate

FR-008 (matches) is enforced at three layers, and S-03 should mirror all three for prediction writes:

1. **RLS (source of truth):** `kickoff_time > now()` in the UPDATE `USING` (`...tournament_and_matches.sql:103-107`). A past-kickoff row falls out of the row set → zero rows affected, silently. This is race-proof.
2. **App pre-check (friendly error):** `src/actions/index.ts:223-237` reads the match's `kickoff_time` and throws `ActionError({code:"FORBIDDEN"})` if `new Date(kickoff).getTime() <= Date.now()`.
3. **Zero-row post-write guard:** `src/actions/index.ts:248-252` treats an empty `.select()` result after the UPDATE as the lock firing.

### Server-side conventions (Actions, clients, zod)

- **All mutations are Astro Actions** in `src/actions/index.ts` (`export const server = { domain: { verb: defineAction({ accept:"json", input: <zod>, handler }) } }`). Helpers: `requireAdmin`, `adminClient(context)`, `internalError`, `inputError` (`...:13-75`). S-03 likely adds a `predictions` namespace here (or a split module).
- **Zod schemas** live in `src/lib/schemas/` (e.g. `match.ts`, `participant.ts`, `tournament.ts`), shared between client `zodResolver` and server `input:`. Add `src/lib/schemas/prediction.ts`.
- **Client SSR (RLS-enforced):** `src/lib/supabase.ts` `createClient(headers, cookies)` via `@supabase/ssr`, secrets from `astro:env/server`. **This is the only client S-03 should use for predictions.**
- **Service-role:** `src/lib/supabase-admin.ts` — the *only* `SUPABASE_SERVICE_ROLE_KEY` reader; its banner comment explicitly names predictions as the thing it must never read (`...supabase-admin.ts:5-18`). Only importer is `participants.create`. S-03 must not import it.
- **No `src/db/*.ts` query layer** — reads are inline in `.astro` frontmatter / actions. No `src/lib/services/` yet.
- **API routes** (`src/pages/api/auth/*.ts`) all carry `export const prerender = false`; S-03 should prefer Actions over new API routes, but any new `src/pages/api/**` must keep that export.
- **DTOs:** `src/types.ts` has framework-level `Profile`/`UserRole` only; app shapes live next to their schemas. Add a `Prediction` DTO + input types.

### Frontend conventions

- **No participant match-list / prediction page exists yet** — greenfield. Closest pattern: `src/pages/admin/index.astro` (SSR Supabase read in frontmatter → map rows with `formatInZone(utc, zone)` + `isPast: utc.getTime() <= now` → pass serializable rows + `timeZone` to a `client:load` React island) (`src/pages/admin/index.astro:11-91`).
- **Form island stack:** RHF + `zodResolver(sharedSchema)` + shadcn `Form/FormField/...` + `await actions.x.y(values)` + `isInputError(error)` → `form.setError`, else `setServerError` (canonical example `src/components/admin/TournamentForm.tsx:25-51`). Use this, NOT the bespoke `SignInForm` native-POST pattern.
- **Middleware** is **default-deny** with `PUBLIC_ROUTES` + `ADMIN_ROUTES` (not `PROTECTED_ROUTES` despite AGENTS wording) (`src/middleware.ts:4-12`). A participant predictions route just needs to be non-public and non-admin — the default gate covers it; `context.locals.user` / `profile` are already populated (`...:39-57`). `SECURITY_HEADERS` applied on every response.
- **shadcn primitives present:** `button, input, label, form, calendar, popover`. Missing and likely needed for a score entry UI: none strictly required (numeric `input` works), but `select`/`radio-group` would be added via `npx shadcn@latest add` per AGENTS.md.
- **Time display:** canonical `"YYYY-MM-DD HH:mm"` via `formatInZone` (`src/lib/time.ts:97-108`); past/future via `isPast` computed server-side. There is no `isFuture` helper — convention is `!isPast`.

### Test-harness convention (FR-015 must be proven)

- The single live-DB RLS harness is `src/db/matches.rls.test.ts` (Vitest, `vitest.config.ts` `happy-dom`). It uses `describe.skipIf(!dbConfigured)` so it is **skipped in CI** (CI runs `npm test` but starts no Supabase).
- Pattern: a `service` client (service-role) for setup/teardown via `auth.admin.createUser`, plus anon clients signed in as the admin and as participant(s) via `signInWithPassword` (`src/db/matches.rls.test.ts:44-88`). Assertions: INSERT denial → expect error (code 42501); UPDATE filtered by `USING` → `error` null + zero rows; allowed update → non-empty rows.
- **S-03 should add `src/db/predictions.rls.test.ts`** asserting the blindness invariant concretely: participant A's pre-kickoff row returns **zero rows** for participant B AND for the admin; the owner always sees their own row; after kickoff all clients see all rows. Run locally with `SUPABASE_DB_URL=... SUPABASE_URL=... SUPABASE_ANON_KEY=... SUPABASE_SERVICE_ROLE_KEY=... npm test -- predictions.rls`.

## Code References

- `supabase/migrations/20260602180000_tournament_and_matches.sql:43-60` — `matches` table (kickoff_time timestamptz, FK cascade, kickoff index, comment deferring participant read to S-03)
- `supabase/migrations/20260602180000_tournament_and_matches.sql:103-107` — `matches_update` kickoff-lock RLS (the precedent)
- `supabase/migrations/20260528232000_identity_boundary.sql:82-93` — `is_admin()` helper
- `supabase/migrations/20260528232000_identity_boundary.sql:163-184` — per-user `profiles`/`user_roles` SELECT policies
- `src/actions/index.ts:13-75` — Action module header + helpers (defense-in-depth doc)
- `src/actions/index.ts:215-254` — `matches.update` (app pre-check + RLS zero-row lock pattern to mirror)
- `src/lib/supabase.ts:8-26` — SSR client (the only client for predictions)
- `src/lib/supabase-admin.ts:5-30` — service-role isolation banner (must never read predictions)
- `src/lib/schemas/match.ts` — shared zod + `.transform()` to UTC `Date` (pattern for prediction schema)
- `src/components/admin/TournamentForm.tsx:25-51` — canonical RHF + zodResolver + actions + isInputError island
- `src/pages/admin/index.astro:11-91` — SSR read → formatInZone/isPast → client:load island (page pattern)
- `src/middleware.ts:4-12,39-77` — default-deny gate + locals + SECURITY_HEADERS
- `src/db/matches.rls.test.ts:44-154` — live-DB RLS harness to copy for predictions
- `src/db/database.types.ts:37-74` — generated `matches` Row/Insert/Update (mirror for predictions)
- `package.json:14-20` — test + db scripts (`db:migration:new`, `db:types`, `db:reset`)

## Architecture Insights

- **Defense-in-depth is the house style:** every invariant is enforced at the DB (RLS, source of truth) AND re-checked in the Action layer for a friendly message. S-03's blindness + kickoff-lock should follow this exactly, with RLS as the bypass-proof backstop.
- **Admin is a participant, not a superuser, for game data.** `is_admin()` gates *administration* (creating matches/tournaments) but must be deliberately absent from the predictions SELECT policy so the admin is blind like everyone else (FR-015/FR-017).
- **Kickoff is a per-row, time-relative predicate** (`kickoff_time > now()` / `< now()`), evaluated in Postgres at query time — no caching layer sits between the policy and the read, which is what makes the blindness boundary trustworthy.
- **CI does not exercise RLS** (live tests skip without local Supabase). The blindness guarantee is only proven by running the RLS test locally — plan a manual/local verification step, and consider whether S-03 warrants a Supabase CI job.
- **No query-service layer exists** — keep prediction reads inline in `.astro`/actions for consistency, or introduce `src/lib/services/` deliberately if complexity warrants (AGENTS.md sanctions it).

## Historical Context (from prior changes)

- `context/foundation/lessons.md` — two recorded lessons: (1) benign unplanned support files (eslint/config/shadcn primitives) show up in feature diffs — expect and pre-declare them; (2) **secret-isolation success criteria should target production reads, not a raw grep across `src/`** (test files reference `SUPABASE_SERVICE_ROLE_KEY` by name) — relevant if S-03's plan asserts service-role isolation.
- `context/archive/2026-06-01-tournament-and-matches/` (S-02) — origin of the matches kickoff-lock pattern and the RLS-test/CI-skip tradeoff; its plan-review explicitly recorded that RLS is not asserted in CI.
- `context/archive/2026-05-28-identity-boundary/` (F-01) — origin of the role model, `is_admin()`, and the per-user RLS patterns.
- `context/archive/2026-06-03-admin-creates-participants/` (S-01) — origin of the service-role isolation constraint that S-03 must preserve.

## Related Research

- None prior for this change; this is the first `research.md` under `context/changes/prediction-with-blindness/`.

## Open Questions

These are design decisions for `/10x-plan` (none block planning):

1. **Exact `predictions` SELECT policy shape.** Owner-OR-post-kickoff via subquery/join to `matches.kickoff_time`. Confirm `now()` is evaluated per-row at fetch time with no caching path that could leak across the kickoff boundary (roadmap unknown). A correlated `EXISTS` subquery vs a join changes the policy ergonomics.
2. **Time source for the kickoff lock on writes.** Server-only (Postgres `now()` + Astro server clock pre-check, matching `matches.update`) vs adding a client-side guard for snappier UX. Server stays source-of-truth either way.
3. **Predictions schema specifics:** FK targets (`predictor_id` → `profiles(id)`/`auth.users(id)`, `match_id` → `matches(id)`), ON DELETE behavior (align with cascade-delete decision for S-06), uniqueness (one prediction per (predictor, match) — likely `unique(predictor_id, match_id)`), and score CHECK constraints (non-negative ints, sane upper bound?).
4. **Participant SELECT scope for `matches`/`tournaments`:** open read to all authenticated participants (simplest) — confirm no data on those tables is sensitive pre-kickoff (it isn't; only predictions are).
5. **"Who has predicted" indicator (US-01 AC, optional):** showing prediction *status* (not values) to others pre-kickoff would need a count/exists path that does not leak values — decide whether to include in S-03 or defer.
6. **CI coverage for the blindness RLS test:** keep local-only (current convention) or add a Supabase-backed CI job given this is the integrity-load-bearing slice.
