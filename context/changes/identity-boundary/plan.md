# Identity Boundary (F-01) Implementation Plan

## Overview

Establish the identity boundary every downstream BetCup slice rides on: ship the first Supabase migration creating `profiles` + `user_roles` with RLS and SQL helper functions; refactor the Astro middleware from a one-route allowlist to a default-deny gate that loads `locals.profile`; retrofit the kept auth handlers to AGENTS.md hard rules (`prerender = false` + `zod`); delete every self-registration surface (UI, handler, form, confirm-email page, Supabase config flags, README); and land a Vitest harness with integration tests covering the default-deny refactor.

## Current State Analysis

The repo as of the planning snapshot:

- **Auth pages** live at `src/pages/auth/{signin,signup,confirm-email}.astro` (not at root). Sign-in posts to `/api/auth/signin`; sign-out to `/api/auth/signout`. Confirm-email is dev-info only.
- **Auth handlers** (`src/pages/api/auth/{signin,signout,signup}.ts`) export `POST` only. **None** export `const prerender = false` — an AGENTS.md hard rule violation that breaks them in production SSR. **None** use `zod` — another AGENTS.md hard rule miss.
- **Middleware** (`src/middleware.ts:4`) protects only `/dashboard` via an allowlist: `const PROTECTED_ROUTES = ["/dashboard"];`. PRD `## Access Control` mandates default-deny ("Any route except the login page redirects unauthenticated users").
- **Supabase SSR client** (`src/lib/supabase.ts:3`) already reads `SUPABASE_URL` / `SUPABASE_KEY` from `astro:env/server` correctly — no env-leak fix needed.
- **Database**: `supabase/config.toml` is present (project id `10x-astro-starter`, Postgres 17, `enable_signup = true` in both `[auth]` and `[auth.email]`, `enable_confirmations = false`). **No `supabase/migrations/` folder, no `seed.sql`, no generated TS types, no application tables.** The `[db.seed]` section references `./seed.sql` (line 65) but the file doesn't exist.
- **Tooling**: `supabase` CLI is in devDependencies (`^2.23.4`) but no npm script wraps it. No `db:start`, `db:types`, etc.
- **Sign-in redirect target** (`src/pages/api/auth/signin.ts:19`) is `/` — but there's no `/` page in the repo. Today this 404s silently after a successful login.
- **CI smoke test** (`.github/workflows/ci.yml:34-78`) boots `wrangler dev` and probes `/auth/signin` (expects 200) and `/dashboard` (expects 302 unauthed). The refactor must keep both green.
- **`src/types.ts`** named in AGENTS.md as the home for shared entity/DTO types — does not exist yet.
- **`src/env.d.ts`** declares `App.Locals.user: User | null` only — no profile/role typing.

## Desired End State

When this plan completes:

1. A new visitor hitting `https://betcup.betcup.workers.dev/anything` is redirected to `/auth/signin` (default-deny middleware).
2. An authenticated participant has `Astro.locals.profile = { id, displayName, roles: ['participant'] }` available in every Astro page and API handler.
3. An authenticated admin has `Astro.locals.profile = { id, displayName, roles: ['participant', 'admin'] }` — the admin holds both role rows per FR-017.
4. The database has `profiles` (with public `display_name` + admin-only `legal_name`) and `user_roles` (with strict self+admin RLS), the SQL helpers `is_admin()` / `is_participant()` / `current_user_roles()`, a `profiles_public` view granted to `authenticated`, and a `handle_new_user` trigger that creates profile + role rows on every `auth.users` insert.
5. `npx supabase start` followed by `npm run db:types` regenerates `src/db/database.types.ts` and produces a typed `Database` generic for `createServerClient<Database>(...)`.
6. `/api/auth/signup` and the entire signup UI are gone; `enable_signup = false` in both `config.toml` blocks; the README no longer documents a signup flow.
7. `npm test` runs Vitest and passes the middleware integration tests.
8. CI's existing smoke test still passes (`/auth/signin` → 200, `/dashboard` → 302 unauthed).

### Verification

- `psql ... -c "SELECT is_admin();"` returns `true` when authenticated as the admin user, `false` otherwise.
- `curl -i https://localhost:8788/predictions` (any non-public path) returns `302 Location: /auth/signin` when unauthed.
- `npx supabase db reset && npm run db:start` ends with the admin user existing in `auth.users` and holding two `user_roles` rows (`admin` + `participant`).
- `npm run lint && npm run build && npm test` all pass.

### Key Discoveries

- Default-deny is the literal PRD contract — "Any route except the login page redirects unauthenticated users to login" (`context/foundation/prd.md:140`). Today's allowlist is the bug F-01 exists to close.
- The smoke test in CI already encodes the desired behavior (`/dashboard` → 302) — Vitest tests are additional coverage of the default-deny logic, not duplicative.
- AGENTS.md treats `nodejs_compat` in `wrangler.jsonc` as a hard guard (`check:wrangler` pre-commit + CI). The flag is present (`wrangler.jsonc:6`) — F-01 does not touch it.
- Supabase's `auth.users` table accepts pre-hashed passwords via `crypt('password', gen_salt('bf', 10))` (pgcrypto bcrypt) — the canonical local-seed pattern. Supabase Studio's "Add user" UI uses the same hashing for production manual creation.
- `ALTER DATABASE postgres SET app.admin_email = '...'` only takes effect on NEW connections. seed.sql must additionally call `SELECT set_config('app.admin_email', '...', false)` so the trigger sees the value in the same session.

## What We're NOT Doing

- Not adding any per-domain tables (tournaments, matches, predictions, scores) — those land in their owning slices (S-02, S-03, S-04). F-01 only ships the identity foundation.
- Not writing pgTAP-style DB function tests — `is_admin()` and friends are exercised implicitly by every downstream RLS policy; F-01's risk concentrates in the middleware refactor, where Vitest covers it.
- Not implementing a "manage participants" admin UI — S-01 owns that.
- Not adding a password-change UI — S-07 owns FR-003.
- Not building a real `/` home page — `src/pages/index.astro` in this plan is a single-redirect bridge, nothing more.
- Not introducing a service-role key into the running Worker — the admin-seed mechanism does not require it (the production path uses Supabase Studio + a trigger reading `app.admin_email`).
- Not setting up Supabase Edge Functions, pg_cron, or any background processing.
- Not introducing observability infrastructure (Sentry, structured logging) — roadmap `## Parked`.
- Not generating documentation beyond the README delta — the plan itself is the design doc.

## Implementation Approach

Four ordered phases, each independently testable and committable. Phase boundaries trace the layers the change touches:

1. **DB foundation** lands a single migration with the full schema + RLS + helper functions + trigger, the npm-script harness for the Supabase CLI, the env-driven seed template, and the generated types. The phase is verifiable purely from `npx supabase db reset` + a few `psql` queries.
2. **App auth-gate refactor** edits the middleware, adds the index-page bridge, retrofits the kept auth handlers, and introduces `src/types.ts` and the `App.Locals.profile` shape. Verifiable via `wrangler dev` + manual visits and (next phase) Vitest.
3. **Self-signup removal** is a deletion phase: four files removed, two config flags flipped, README cleaned. Verifiable via `git status` (4 deletions), `npm run build` (no broken imports), and a manual `curl` to the now-404 endpoints.
4. **Test harness** installs Vitest + happy-dom, writes `vitest.config.ts`, and lands the middleware integration tests. Verifiable via `npm test`.

The order keeps each phase reviewable on its own and lets a partial revert (e.g., revert Phase 3 only) restore signup without un-doing the schema work.

## Critical Implementation Details

The constraints below are non-obvious and load-bearing — they are the gotchas that would otherwise eat planning's gains in implementation.

- **`profiles_public` view is the canonical read path for non-admin code.** RLS on `profiles` denies cross-user direct reads (`USING (auth.uid() = id OR is_admin())`). The view exposes only the public columns (`id`, `display_name`, `created_at`, `updated_at`) and is granted to `authenticated`. Every downstream slice that needs to list participants for a non-admin user (S-04 leaderboard, S-05 history references) MUST query `profiles_public`, not `profiles`. A SELECT against `profiles` from non-admin code will return zero rows for other users; the failure mode is silent (empty result) which is exactly the bug shape that would surface late.
- **Trigger SECURITY mode**: `handle_new_user` must be `SECURITY DEFINER` to insert into `public.profiles` and `public.user_roles` from the `auth.users` insert context. SQL helpers (`is_admin`, `is_participant`, `current_user_roles`) must be `SECURITY INVOKER` so they read with the calling user's RLS — making `is_admin()` callable from RLS policies without infinite recursion.
- **`app.admin_email` propagation**: `ALTER DATABASE postgres SET app.admin_email = '...'` only applies on new connections. seed.sql must call `SELECT set_config('app.admin_email', '...', false)` BEFORE the `INSERT INTO auth.users` so the trigger (fired in the same session) sees the value. The `ALTER DATABASE` line is for persistence across sessions; without `set_config` the FIRST seed run would silently fail to promote the admin.
- **Admin holds two `user_roles` rows**: FR-017 ("admin is also a participant") is encoded by `UNIQUE(user_id, role)` allowing multiple rows per user; the trigger inserts a `'participant'` row for every new auth.users row AND an additional `'admin'` row when the email matches `app.admin_email`. `is_admin()` reads `EXISTS(... AND role = 'admin')`; `is_participant()` reads `EXISTS(... AND role = 'participant')`. The admin gets both checks returning true with no special casing.
- **`SUPABASE_KEY` is the anon key, never the service-role key.** The Worker only ever holds anon. The trigger-based admin promotion eliminates the need for service-role in any runtime code; rotating `SUPABASE_KEY` is still a manual-approval gate per AGENTS.md.
- **`src/db/database.types.ts` is generated, not hand-edited.** It's checked in (so the build doesn't need the Supabase CLI), regenerated by `npm run db:types` whenever a migration lands. AGENTS.md's `src/types.ts` is the home for hand-written DTO types (`UserRole`, `Profile`); the two files are siblings in semantics, not nested.
- **Middleware extra DB read**: loading `locals.profile` adds one query per authed request on top of `supabase.auth.getUser()`. Single round-trip joining `profiles` + `user_roles` via a small SQL view or function. At the 5-20 user scale this is unmeasurable; mention in case S-04 leaderboard hits the same query pattern and needs deduping.
- **CI smoke compatibility**: the smoke job posts to `/auth/signin` (200) and `/dashboard` (302). With default-deny, ANY new authed path also returns 302 — fine for the existing checks, but if a future slice adds a public asset path, it must land in `PUBLIC_ROUTES` first or smoke will fail in CI.

## Phase 1: DB Foundation

### Overview

Land the first Supabase migration creating the full identity schema (tables, enum, RLS, helpers, trigger, view), wire the npm-script harness for the Supabase CLI, generate the env-driven seed template + generator script, commit the first generated `database.types.ts`, and document the `.env` admin variables.

### Changes Required

#### 1. First migration

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_identity_boundary.sql` (new)

**Intent**: Establish the identity tables, the role enum, the SECURITY DEFINER trigger that promotes the admin, the SECURITY INVOKER SQL helpers used by every downstream RLS policy, the `profiles_public` view that is the canonical non-admin read path, and the strict RLS policies on both tables.

**Contract**: A single migration file containing the following objects (in dependency order):

1. `pgcrypto` extension enable (Supabase usually has it but be explicit).
2. Enum: `user_role` with values `'admin'` and `'participant'`.
3. Table `public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, display_name text NOT NULL, legal_name text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())`. Trigger `updated_at_profiles` on UPDATE to keep `updated_at` fresh.
4. Table `public.user_roles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, role user_role NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, role))`. Index on `user_id`.
5. View `public.profiles_public` as `SELECT id, display_name, created_at, updated_at FROM public.profiles`. The view runs with definer privileges by default (Postgres < 15 behavior) — but on PG17 we make it explicit: `WITH (security_invoker = false)`. `GRANT SELECT ON public.profiles_public TO authenticated, anon`.
6. Function `public.is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER AS $$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin') $$`.
7. Function `public.is_participant() RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER AS $$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'participant') $$`.
8. Function `public.current_user_roles() RETURNS user_role[] LANGUAGE sql STABLE SECURITY INVOKER AS $$ SELECT array_agg(role) FROM public.user_roles WHERE user_id = auth.uid() $$`.
9. Function `public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER` that:
   - Inserts into `public.profiles(id, display_name)` with display_name from `NEW.raw_user_meta_data->>'display_name'` falling back to the local-part of `NEW.email`.
   - Inserts into `public.user_roles(user_id, role)` with role = `'participant'`.
   - If `NEW.email = current_setting('app.admin_email', true)`, additionally inserts the `'admin'` role row.
10. Trigger `on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user()`.
11. RLS enable on `profiles` + `user_roles`.
12. RLS policies:
    - `profiles SELECT`: `USING (auth.uid() = id OR public.is_admin())`.
    - `profiles UPDATE`: `USING (auth.uid() = id) WITH CHECK (auth.uid() = id)` — only self-update of `display_name` for now (admin write paths land in S-01 via the service-role-less admin-as-authed-user; FR-001 will revisit).
    - `profiles INSERT`: no policy → blocked for clients (only the trigger writes).
    - `profiles DELETE`: `USING (public.is_admin())` — admin can hard-delete (S-06 owns the UI; the policy lands now to keep S-06's diff small).
    - `user_roles SELECT`: `USING (auth.uid() = user_id OR public.is_admin())`.
    - `user_roles INSERT/UPDATE/DELETE`: no policy → blocked for clients (only the trigger and admin paths via future service-role-less admin handlers will write).
13. `COMMENT ON` clauses on each table and the view documenting the privacy boundary (legal_name admin-only, profiles_public is the canonical non-admin read path).

The migration is a single file because every object is in one dependency chain — splitting buys nothing reviewable.

#### 2. Seed template + generator

**File**: `supabase/seed.sql.template` (new, committed)

**Intent**: Template for the local-dev admin seed; checked in so contributors share the same seed shape; consumed by the generator script.

**Contract**: SQL file with two placeholders, `{{ADMIN_EMAIL}}` and `{{ADMIN_PASSWORD}}`. The body sets `app.admin_email` (both `ALTER DATABASE` and `set_config` per the gotcha above), then INSERTs a row into `auth.users` with the email and a `crypt({{ADMIN_PASSWORD}}, gen_salt('bf', 10))` encrypted password, `email_confirmed_at = now()`, the standard `aud='authenticated'`/`role='authenticated'` columns, `raw_user_meta_data = jsonb_build_object('display_name', 'Admin')`, and the various empty token columns Supabase expects. The trigger fires on this insert and creates both profile + user_roles rows.

**File**: `supabase/seed.sql` (new, gitignored)

**Intent**: The generated file actually consumed by `supabase start`. Never committed.

**Contract**: byte-for-byte template with placeholders substituted from `.env`. Regenerated on every `npm run db:start`.

**File**: `scripts/seed-template.mjs` (new)

**Intent**: Reads `.env` (via `dotenv`), validates that `ADMIN_EMAIL` and `ADMIN_PASSWORD` exist, fails loudly if missing, then templates `supabase/seed.sql.template` into `supabase/seed.sql`. Pure text replacement.

**Contract**: A Node ESM script (no TypeScript — keeps the toolchain off the critical path). Imports `dotenv/config`, `fs`, `path`. Throws if either env var is unset. Writes the templated file with a leading comment `-- GENERATED FROM supabase/seed.sql.template — DO NOT EDIT`.

#### 3. npm scripts + dependencies

**File**: `package.json` (edit)

**Intent**: Add the four canonical Supabase CLI wrapper scripts plus a `db:start` that templates the seed first; add `dotenv` to devDependencies.

**Contract**: New scripts in this order, after the existing scripts block:

- `db:start`: `node scripts/seed-template.mjs && npx supabase start`
- `db:stop`: `npx supabase stop`
- `db:migration:new`: `npx supabase migration new` (the operator passes the migration name as an argument)
- `db:types`: `npx supabase gen types typescript --local > src/db/database.types.ts`
- `db:reset`: `node scripts/seed-template.mjs && npx supabase db reset` (handy during development)

Add `dotenv` to devDependencies (latest 16.x).

#### 4. .env wiring

**File**: `.env.example` (edit)

**Intent**: Document the two new admin variables so a fresh contributor has the signal of what to set.

**Contract**: append:

```
ADMIN_EMAIL=admin@betcup.local
ADMIN_PASSWORD=change-me-locally
```

**File**: `.gitignore` (edit)

**Intent**: Stop tracking the generated `supabase/seed.sql` (the template is committed; the generated file is not).

**Contract**: append `supabase/seed.sql` on its own line.

#### 5. Generated TS types

**File**: `src/db/database.types.ts` (new, generated)

**Intent**: First generation of the typed Supabase Database type, committed to the repo so the build does not require the Supabase CLI to be installed in CI.

**Contract**: Run `npm run db:start` then `npm run db:types`; commit the resulting file as-is. The file's first line is the standard Supabase codegen header.

#### 6. README delta

**File**: `README.md` (edit)

**Intent**: Replace the now-incorrect "No database tables or migrations are required" sentence and document the new admin-env-var requirement + the new npm-script harness.

**Contract**: Edits to the "Supabase Configuration" section:

- Remove or replace the line `113-114` "No database tables or migrations are required — this project uses Supabase Auth's built-in `auth.users` table only."
- Add a "Local admin seed" subsection explaining that contributors must set `ADMIN_EMAIL`/`ADMIN_PASSWORD` in `.env` and that `npm run db:start` will template the seed and start Supabase.
- Add a "Production admin bootstrap" subsection with the manual steps: open Supabase Studio SQL editor → `ALTER DATABASE postgres SET app.admin_email = '<real-admin-email>';` → use "Authentication > Add user" with that email; the trigger handles role assignment.
- Add the four `db:*` npm scripts to the scripts-table if one exists.

### Success Criteria

#### Automated Verification

- Migration applies cleanly: `npx supabase db reset` completes without error.
- Types generate without diagnostics: `npm run db:types` exits 0 and produces a non-empty `src/db/database.types.ts`.
- Type check passes: `npx astro sync && npm run lint` is clean (lint is type-aware per `eslint.config.js`).
- The generated `supabase/seed.sql` is NOT tracked by git: `git status` shows no entry for it after `npm run db:start`.
- The template generator fails loudly when `.env` is missing: `unset ADMIN_EMAIL && node scripts/seed-template.mjs` exits non-zero with a clear message.
- After `npm run db:start` plus a fresh login as the admin: `psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "SELECT email, (SELECT array_agg(role) FROM public.user_roles WHERE user_id = u.id) FROM auth.users u;"` shows the admin email with `{participant,admin}` in the role array.
- Same query against a manually created second user (via Studio) shows `{participant}` only.

#### Manual Verification

- Open Supabase Studio (`http://127.0.0.1:54323`), confirm `profiles` + `user_roles` tables exist with RLS enabled.
- In Studio's SQL editor, run `SELECT * FROM public.profiles_public;` as anon — returns all rows. Run `SELECT legal_name FROM public.profiles;` as anon — returns zero rows for non-admin users (cross-user RLS denies).
- README's "Production admin bootstrap" subsection has the exact SQL the operator will paste.

**Implementation Note**: After Phase 1's automated verification, pause for manual confirmation that Supabase Studio shows the expected schema and RLS state before starting Phase 2.

---

## Phase 2: App Auth-Gate Refactor

### Overview

Refactor the Astro middleware from allowlist to default-deny; add the `locals.profile` loader; create `src/pages/index.astro` as the post-login bridge to `/dashboard`; retrofit `signin.ts` and `signout.ts` to AGENTS.md hard rules (`prerender = false` + `zod` on signin); introduce `src/types.ts` with the `UserRole` and `Profile` DTO types; extend `src/env.d.ts` so `App.Locals.profile` has a strict type.

### Changes Required

#### 1. Shared DTO types

**File**: `src/types.ts` (new)

**Intent**: First entry in the AGENTS.md-canonical home for hand-written entity and DTO types. Exports `UserRole` (literal union, not the generated DB enum — DTOs are framework-facing) and `Profile` (the shape passed through `Astro.locals` and into UI components).

**Contract**: Two exports, sentence-cased, with TSDoc:

- `export type UserRole = "admin" | "participant";`
- `export interface Profile { id: string; displayName: string; roles: UserRole[]; }`

No imports from `@/db/database.types` here — `src/types.ts` is the framework-facing layer; bridging from generated DB types happens in `src/lib/supabase.ts` (or a small mapper).

#### 2. Locals typing

**File**: `src/env.d.ts` (edit)

**Intent**: Extend `App.Locals` with the new `profile` slot. Keep `user` for compatibility (display name email fallback in `dashboard.astro:13` still references it).

**Contract**: import `Profile` from `@/types`; add `profile: Profile | null` to the interface. Final shape:

```typescript
declare namespace App {
  interface Locals {
    user: import("@supabase/supabase-js").User | null;
    profile: import("@/types").Profile | null;
  }
}
```

#### 3. Profile loader

**File**: `src/lib/supabase.ts` (edit)

**Intent**: Add a small `loadProfile(supabase, userId)` helper that returns a `Profile | null` by joining `profiles` and aggregating roles from `user_roles`. The public signature of `createClient` is unchanged (callers in `middleware.ts` and the API handlers keep the same call shape), but internally the `createServerClient(...)` call gains a `<Database>` generic so the returned client is typed end-to-end — without this, `loadProfile`'s typed parameter rejects the call site.

**Contract**: Two edits to the file plus one new export:

1. Add `import type { Database } from "@/db/database.types";` at the top of the file.
2. Change the internal `createServerClient(SUPABASE_URL, SUPABASE_KEY, { ... })` call (line 9 in the current file) to `createServerClient<Database>(SUPABASE_URL, SUPABASE_KEY, { ... })`. The public return type of `createClient` is now `SupabaseClient<Database> | null` (it was `SupabaseClient | null`); call sites are unchanged because they don't annotate the variable.
3. New exported function `loadProfile(supabase: SupabaseClient<Database>, userId: string): Promise<Profile | null>`. Single SQL: `select id, display_name, (select array_agg(role) from public.user_roles where user_id = profiles.id) as roles from public.profiles where id = $1`. Map the result to the `Profile` DTO. Return `null` if the row is absent (the trigger ensures it exists for every authed user, so `null` indicates a race / inconsistency worth logging).

#### 4. Middleware default-deny refactor

**File**: `src/middleware.ts` (edit)

**Intent**: Replace `PROTECTED_ROUTES` with `PUBLIC_ROUTES`; gate by exclusion so a new page is private unless explicitly listed. Additionally load `locals.profile` for authed requests; redirect authed users hitting `/auth/signin` straight to `/dashboard` (FR-005 spirit: the login page is for the unauthed).

**Contract**: The final middleware shape:

- `PUBLIC_ROUTES = ["/auth/signin", "/api/auth/signin", "/api/auth/signout"]`. Note: `/api/auth/signout` is public because the form on `/dashboard` posts to it from any logged-in (but session-clearing) state; treating it as "public" avoids a refresh-token race. `/auth/signup`, `/api/auth/signup`, `/auth/confirm-email` are NOT in this list — Phase 3 deletes them.
- A helper `isPublic(pathname: string): boolean` matches any prefix in `PUBLIC_ROUTES`.
- After `supabase.auth.getUser()`, when a user is present: call `loadProfile(supabase, user.id)` and set `context.locals.profile`. When absent: set both `locals.user` and `locals.profile` to `null`.
- New gating logic (replacing the existing `PROTECTED_ROUTES` block):
  - If `isPublic(pathname)` and `locals.user`: redirect `/auth/signin` → `/dashboard`. Other public paths stay as-is.
  - If `!isPublic(pathname)` and `!locals.user`: redirect to `/auth/signin`.
  - Otherwise: proceed.
- Security headers block (lines 6-17, 37-41) is preserved unchanged.

#### 5. Post-login index bridge

**File**: `src/pages/index.astro` (new)

**Intent**: Give `/` a coherent destination so a bare-domain visit doesn't 404. Middleware default-deny handles the unauthed case (redirects to `/auth/signin`); this page handles the authed case by redirecting to `/dashboard`.

**Contract**: Astro page with only a frontmatter block that calls `Astro.redirect("/dashboard", 302)`. No body — the redirect short-circuits rendering.

#### 6. Signin handler retrofit

**File**: `src/pages/api/auth/signin.ts` (edit)

**Intent**: Add `const prerender = false` (AGENTS.md hard rule, the bug this file currently is). Replace the `as string` casts with a `zod` schema. Change the success redirect target from `/` to `/dashboard`.

**Contract**: Final shape:

- `export const prerender = false;` at module scope.
- `const SigninSchema = z.object({ email: z.string().email(), password: z.string().min(6) });`
- Parse `formData` into a plain object, run `SigninSchema.safeParse`; on failure, redirect to `/auth/signin?error=<flattened-issue-message>`.
- Success redirect target: `/dashboard` instead of `/`.
- Add `zod` to dependencies (not devDependencies — runtime use).

#### 7. Signout handler retrofit

**File**: `src/pages/api/auth/signout.ts` (edit)

**Intent**: Add `const prerender = false`. No input → no `zod` schema needed. Change the redirect target from `/` to `/auth/signin` to collapse the post-signout 2-hop chain (`/api/auth/signout → / → /auth/signin via middleware`) into a single hop. The PRD's "no public landing page; BetCup is private by default" means `/` will never be a different destination for an unauthed user, so the direct redirect is functionally equivalent and one HTTP response cheaper.

**Contract**: Two edits:

1. Add the line `export const prerender = false;` at module scope.
2. Change the redirect on line 9 of the current file from `context.redirect("/")` to `context.redirect("/auth/signin")`.

#### 8. Dashboard display-name swap

**File**: `src/pages/dashboard.astro` (edit)

**Intent**: Now that `locals.profile.displayName` exists, prefer it over the raw email for the welcome line. Falls back to email if profile is somehow null (shouldn't happen post-Phase-1 but defensive).

**Contract**: Replace the `{user?.email}` interpolation with `{profile?.displayName ?? user?.email}`. Add `profile` to the destructuring at line 4.

### Success Criteria

#### Automated Verification

- Type check passes: `npx astro sync && npm run lint` is clean.
- Build passes: `npm run build` succeeds.
- `check:wrangler` passes: `npm run check:wrangler` exits 0 (the `nodejs_compat` flag is untouched).

#### Manual Verification

- `npm run dev` then visit `/` while unauthed → redirected to `/auth/signin`.
- Visit `/anything-random` while unauthed → redirected to `/auth/signin`.
- Visit `/auth/signin` while unauthed → 200, form renders.
- Sign in with admin credentials → redirected to `/dashboard`; the page reads "Welcome, Admin" (displayName from profile, not email local-part).
- Visit `/auth/signin` while authed → redirected to `/dashboard` (no re-render of the form).
- Visit `/` while authed → redirected to `/dashboard`.
- Browser devtools Network tab: each request returns the `Strict-Transport-Security` and other security headers (regression check on lines 6-17 / 37-41 preservation).
- Sign out via the form on `/dashboard` → redirected to `/` → `/auth/signin` (cookie cleared, middleware now sees unauthed).

**Implementation Note**: After Phase 2's automated verification, pause for manual confirmation of the eight URL-behavior checks above before starting Phase 3.

---

## Phase 3: Self-Signup Removal

### Overview

Delete every self-registration surface from the repo and the Supabase config: four files, the link in `signin.astro`, both `enable_signup` flags in `supabase/config.toml`, and the matching README section.

### Changes Required

#### 1. File deletions

**Files** (delete):

- `src/pages/auth/signup.astro`
- `src/pages/api/auth/signup.ts`
- `src/components/auth/SignUpForm.tsx`
- `src/pages/auth/confirm-email.astro`

**Intent**: Eliminate every code path that creates a user without admin involvement, per PRD non-goal #2 (no self-registration) and per the FR-015 blindness integrity argument (a self-registered user would never have been seeded by the admin and could land in an inconsistent state).

**Contract**: After deletion, `grep -r "signup\|SignUpForm\|confirm-email"` in `src/` should return only references in `src/pages/auth/signin.astro` (the "Don't have an account? Sign up" link, removed in step 2) and possibly comment-only references — all of which Phase 3 cleans.

#### 2. Signin link removal

**File**: `src/pages/auth/signin.astro` (edit)

**Intent**: Remove the link to `/auth/signup` (lines 17-19 in the current file). The signin page now contains no path to self-registration.

**Contract**: Delete the entire `<a href="/auth/signup">...</a>` block (or its enclosing wrapper if the link was the only content). The "forgot password" link, if present, stays.

#### 3. Supabase config flag flips

**File**: `supabase/config.toml` (edit)

**Intent**: Belt-and-suspenders — even a crafted `POST /api/auth/signup` (which no longer routes anywhere) or a Supabase JS client call from elsewhere now returns 422 from the auth server because signup is disabled at the database layer.

**Contract**: Two edits, both flipping `true` → `false`:

- `[auth].enable_signup = false` (line 169 in current file).
- `[auth.email].enable_signup = false` (line 204 in current file).

Both lines are documented inline already; the diff is one character per line.

#### 4. README cleanup

**File**: `README.md` (edit)

**Intent**: Remove documentation of the signup flow + confirm-email page; references to `/auth/signup`, `/auth/confirm-email`, and the "By default Supabase requires email confirmation" stanza are stale post-deletion.

**Contract**: Edit the "Auth routes" subsection (lines 140-149) to list only `/auth/signin`, `/dashboard`, and the two API routes that survive (`/api/auth/signin`, `/api/auth/signout`). Delete the "Email confirmation note" block (lines 130-138).

### Success Criteria

#### Automated Verification

- Type check + lint pass: `npx astro sync && npm run lint` is clean (no orphan imports of the deleted form).
- Build passes: `npm run build` succeeds.
- `check:wrangler` passes.
- `git status` shows exactly four deletions (`signup.astro`, `signup.ts`, `SignUpForm.tsx`, `confirm-email.astro`) and the edits to `signin.astro`, `config.toml`, `README.md`.

#### Manual Verification

- `curl -i http://localhost:8788/auth/signup` returns 404.
- `curl -i -X POST http://localhost:8788/api/auth/signup` returns 404.
- Direct API call to the local Supabase auth endpoint `POST http://127.0.0.1:54321/auth/v1/signup` returns a JSON error indicating signup is disabled (`"msg": "Signups not allowed for this instance"` or similar — confirms config.toml flips took effect on `db:start`).
- `signin.astro` no longer shows a "Don't have an account?" link in the rendered UI.
- README scan: no occurrences of `signup`, `SignUpForm`, `/auth/signup`, or `confirm-email`.

**Implementation Note**: After Phase 3's automated verification, pause for manual confirmation that the four URL/API/UI/doc checks above all hold before starting Phase 4.

---

## Phase 4: Test Harness

### Overview

Install Vitest + happy-dom; write `vitest.config.ts`; add an `npm test` script; land middleware integration tests covering the default-deny gate's six branches (public-while-unauthed, public-while-authed, private-while-unauthed, private-while-authed, `/auth/signin`-while-authed-redirects-to-dashboard, profile-loader-populates-locals); wire `npm test` into the CI `ci` job.

### Changes Required

#### 1. Dependencies + scripts

**File**: `package.json` (edit)

**Intent**: Add Vitest + happy-dom (no component-test matcher infra yet — `@testing-library/jest-dom` lands with the first real component test, not pre-emptively). Add `npm test` and `npm run test:watch` scripts.

**Contract**: New devDependencies:

- `vitest` (latest 2.x)
- `@vitest/coverage-v8` (matching major)
- `happy-dom` (latest)

New scripts:

- `test`: `vitest run`
- `test:watch`: `vitest`

#### 2. Vitest configuration

**File**: `vitest.config.ts` (new)

**Intent**: Minimal Vitest config that resolves the `@/*` path alias (matching `tsconfig.json`) and uses happy-dom as the test environment for code that imports from Astro / browser-ish modules.

**Contract**: Default-exported config from `defineConfig` (`vitest/config`). `test.environment = "happy-dom"`. `resolve.alias = { "@": new URL("./src/", import.meta.url).pathname }` (or use `vite-tsconfig-paths` to mirror `tsconfig.json` automatically; the explicit alias is simpler for the first test file).

#### 3. Middleware tests

**File**: `src/middleware.test.ts` (new)

**Intent**: Six integration tests, each calling the exported `onRequest` with a mocked context and asserting on the response (status code + Location header).

**Contract**: Tests:

1. `unauthed visit to /predictions redirects to /auth/signin (302)` — mocks `createClient` to return a client whose `auth.getUser()` resolves to `{ data: { user: null } }` (the normal-auth code path with no session); asserts the 302 + Location. The null-client branch (env missing) is the env-error safety net, not exercised here — if F-01 ever needs explicit coverage of that branch, add a seventh test rather than overloading test 1.
2. `unauthed visit to /auth/signin returns the next response (200 passthrough)` — same mock; asserts `next()` was called once and the response wasn't redirected.
3. `authed visit to /dashboard returns the next response` — mocks `auth.getUser()` returning a user; asserts `next()` called once, no redirect.
4. `authed visit to /auth/signin redirects to /dashboard` — same authed mock; asserts the 302 + Location to `/dashboard`.
5. `authed request sets locals.profile from loadProfile` — mocks both `auth.getUser()` (returns user) and the underlying SQL query (returns one profile + roles); asserts `locals.profile.displayName` and `locals.profile.roles` are populated.
6. `unauthed request sets locals.user and locals.profile to null` — asserts both null after middleware runs against `/`.

Use Vitest's `vi.mock("@/lib/supabase", ...)` to swap `createClient` and `loadProfile`. Build a `mockAstroContext(pathname, { authed })` test helper that returns a minimal `APIContext`-shaped object the middleware uses.

#### 4. CI runs the new tests

**File**: `.github/workflows/ci.yml` (edit)

**Intent**: Wire `npm test` into the existing `ci` job so the middleware tests run on every PR and push. Position it between lint and build so a failing test surfaces before the more expensive build step.

**Contract**: Insert one new step in the `ci` job (`.github/workflows/ci.yml:10-25`), between the existing `- run: npm run lint` step (line 21) and the `- run: npm run build` step (line 22):

```yaml
      - run: npm test
```

No other CI changes — the `smoke` and `deploy` jobs are untouched. Adds ~10 seconds to CI wall time at the current test count.

### Success Criteria

#### Automated Verification

- `npm test` exits 0 and reports six passing tests under `src/middleware.test.ts`.
- `npm run lint` passes (Vitest globals are typed via `vitest/config` — no `any` leaks).
- Build still passes: `npm run build` clean.

#### Manual Verification

- `npm run test:watch` boots and re-runs on edit.
- CI run on the PR: the existing `ci` job runs `npm test` (add to the job — see below) and reports passing; the existing `smoke` job still passes its two URL checks.
- The `.github/workflows/ci.yml` `ci` job has `npm test` inserted between `npm run lint` and `npm run build` (one-line YAML edit).

**Implementation Note**: After Phase 4's automated verification, pause for manual confirmation that the CI test step runs locally as expected and that `npm test` is integrated into `.github/workflows/ci.yml` before considering F-01 complete.

---

## Testing Strategy

### Unit Tests

- The SQL helpers (`is_admin`, `is_participant`, `current_user_roles`) are not unit-tested directly in F-01. Their behavior is exercised implicitly through the middleware integration tests (which call `loadProfile`, which queries the helpers indirectly) and through Studio inspection in Phase 1 manual verification.
- `loadProfile` is mocked in middleware tests rather than tested separately; its first standalone test lands when a slice consumes it for a real read (S-01 admin lookup).

### Integration Tests

- The six middleware tests in Phase 4 are the end-to-end gate coverage for F-01.
- The CI `smoke` job (`.github/workflows/ci.yml:34-78`) provides redundant URL-level verification via real `wrangler dev`.

### Manual Testing Steps

End-to-end manual walk-through that exercises every phase together:

1. Fresh `npm install`, fresh `.env` with `ADMIN_EMAIL=admin@betcup.local` and `ADMIN_PASSWORD=local-only`.
2. `npm run db:start` — Supabase starts, seed.sql is templated + applied, admin row exists in `auth.users` with two `user_roles` rows.
3. `npm run db:types` — `src/db/database.types.ts` regenerates with no diff (file was committed from the same migration; sanity check).
4. `npm run dev` — Astro starts on Cloudflare workerd.
5. Visit `http://localhost:8788/` → redirected to `/auth/signin`.
6. Visit `http://localhost:8788/anything-random` → redirected to `/auth/signin`.
7. Visit `http://localhost:8788/auth/signup` → 404.
8. Sign in with `admin@betcup.local` / `local-only` → redirected to `/dashboard` showing "Welcome, Admin".
9. Visit `/auth/signin` while still authed → redirected to `/dashboard`.
10. In Studio SQL editor, `SELECT * FROM public.profiles_public;` (as anon) returns the admin row WITHOUT `legal_name`. `SELECT legal_name FROM public.profiles;` (as anon) returns zero rows due to RLS. `SELECT * FROM public.profiles;` (as the admin's authed JWT, using the Supabase Studio "Run as user" feature if available, or via the SDK) returns the row with `legal_name` (currently NULL).
11. Sign out → redirected to `/` → `/auth/signin`. Visit any private path → 302 again. End-to-end loop closed.

## Performance Considerations

- Middleware adds one extra SQL round-trip per authed request (the `loadProfile` query). At the BetCup target scale (5-20 concurrent users, all on Cloudflare Workers with Supabase in a single region) this is unmeasurable.
- The `profiles_public` view has no caching; it's a simple SELECT against an indexed table. Downstream slices doing leaderboard reads should consider a CTE/JOIN rather than N+1 round-trips per row, but that's S-04's concern.
- The `handle_new_user` trigger runs once per signup. Since signup is now admin-only, trigger frequency is bounded by admin workflow (handful of inserts per tournament setup).
- RLS policies are simple equality + `is_admin()` calls — no joins on the hot read path.

## Migration Notes

- **No existing production data**: this is the first migration. `supabase db reset` is safe. CI's `smoke` job runs against a built Worker (no DB schema needed for the URL checks).
- **Cloud production deploy**: the migration runs via `npx supabase db push` against the production project (operator step, NOT auto-deployed by the CI deploy job — the deploy job only ships the Worker, per AGENTS.md "Manual approval gates" for column drops/renames; an initial schema is not in that gate but as a first migration it deserves a manual run regardless).
- **Rollback contract**: per AGENTS.md, Supabase migrations do NOT roll back with the Worker. If F-01 needs to be reverted post-deploy, the operator must `supabase db reset` to the pre-F-01 state (empty) AND `wrangler rollback` the Worker. F-01 is the first migration, so "pre-F-01" is the empty database — clean revert path.

## References

- Change folder: `context/changes/identity-boundary/`
- PRD: `context/foundation/prd.md` — see FR-005 (auth gate), FR-017 (admin is also a participant), `## Access Control` (default-deny mandate), `## Non-Goals` #2 (no self-registration).
- Roadmap row: `context/foundation/roadmap.md:32` (At-a-glance) and `:64-77` (F-01 detail) — outcome, unknowns, risk.
- AGENTS.md hard rules: `AGENTS.md` (workspace root) — `prerender = false`, `astro:env/server`, RLS-by-default, `zod` validation, `cn()` for classes, no `"use client"`, shadcn-only UI primitives.
- Existing middleware shape to refactor: `src/middleware.ts:1-42`.
- Existing supabase client to extend: `src/lib/supabase.ts:1-23`.
- Existing handlers to retrofit: `src/pages/api/auth/{signin,signout}.ts`.
- CI smoke contract to preserve: `.github/workflows/ci.yml:34-78`.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: DB Foundation

#### Automated

- [ ] 1.1 Migration applies cleanly: `npx supabase db reset` completes without error
- [ ] 1.2 Types generate without diagnostics: `npm run db:types` exits 0 and produces a non-empty `src/db/database.types.ts`
- [ ] 1.3 Type check passes: `npx astro sync && npm run lint` is clean
- [ ] 1.4 Generated `supabase/seed.sql` is NOT tracked by git after `npm run db:start`
- [ ] 1.5 Template generator fails loudly when `.env` is missing: `unset ADMIN_EMAIL && node scripts/seed-template.mjs` exits non-zero
- [ ] 1.6 Admin user has `{participant, admin}` in `user_roles`; second manually created user has `{participant}` only

#### Manual

- [ ] 1.7 Supabase Studio shows `profiles` + `user_roles` with RLS enabled
- [ ] 1.8 `SELECT * FROM public.profiles_public` as anon returns all rows (no `legal_name`)
- [ ] 1.9 `SELECT legal_name FROM public.profiles` as anon returns zero rows
- [ ] 1.10 README's "Production admin bootstrap" subsection contains the exact operator SQL

### Phase 2: App Auth-Gate Refactor

#### Automated

- [ ] 2.1 Type check passes: `npx astro sync && npm run lint` is clean
- [ ] 2.2 Build passes: `npm run build` succeeds
- [ ] 2.3 `check:wrangler` passes: `npm run check:wrangler` exits 0

#### Manual

- [ ] 2.4 Unauthed visit to `/` redirects to `/auth/signin`
- [ ] 2.5 Unauthed visit to any random path redirects to `/auth/signin`
- [ ] 2.6 Unauthed visit to `/auth/signin` returns 200 with the form
- [ ] 2.7 Sign-in with admin credentials redirects to `/dashboard` showing "Welcome, Admin" (displayName, not email local-part)
- [ ] 2.8 Authed visit to `/auth/signin` redirects to `/dashboard`
- [ ] 2.9 Authed visit to `/` redirects to `/dashboard`
- [ ] 2.10 Security headers (HSTS, CSP, etc.) still set on every response
- [ ] 2.11 Sign-out from `/dashboard` clears session and lands directly on `/auth/signin` (single hop, no intermediate `/` redirect)

### Phase 3: Self-Signup Removal

#### Automated

- [ ] 3.1 Type check + lint pass: `npx astro sync && npm run lint` clean
- [ ] 3.2 Build passes: `npm run build` succeeds
- [ ] 3.3 `check:wrangler` passes
- [ ] 3.4 `git status` shows four deletions plus edits to `signin.astro`, `config.toml`, `README.md`

#### Manual

- [ ] 3.5 `curl -i http://localhost:8788/auth/signup` returns 404
- [ ] 3.6 `curl -i -X POST http://localhost:8788/api/auth/signup` returns 404
- [ ] 3.7 Direct call to local Supabase `POST /auth/v1/signup` returns "Signups not allowed for this instance"
- [ ] 3.8 `signin.astro` no longer shows a "Don't have an account?" link
- [ ] 3.9 README has no occurrences of `signup`, `SignUpForm`, `/auth/signup`, or `confirm-email`

### Phase 4: Test Harness

#### Automated

- [ ] 4.1 `npm test` exits 0 and reports six passing tests under `src/middleware.test.ts`
- [ ] 4.2 `npm run lint` passes (no `any` leaks from Vitest globals)
- [ ] 4.3 Build still passes: `npm run build` clean

#### Manual

- [ ] 4.4 `npm run test:watch` boots and re-runs on edit
- [ ] 4.5 CI run on the PR: `ci` job runs `npm test` and reports passing
- [ ] 4.6 CI `smoke` job still passes its two URL checks
- [ ] 4.7 `.github/workflows/ci.yml` `ci` job has `npm test` inserted between `npm run lint` and `npm run build`
