# Identity Boundary (F-01) — Plan Brief

> Full plan: `context/changes/identity-boundary/plan.md`
> Roadmap row: `context/foundation/roadmap.md:32` (index) + `:64-77` (detail)
> PRD refs: FR-005, FR-017, `## Access Control`, Non-Goals #2

## What & Why

Establish the identity boundary every downstream BetCup slice rides on: ship the first Supabase migration (profiles + user_roles + RLS + helpers + trigger), refactor the Astro middleware from a one-route allowlist to a default-deny gate, retrofit kept auth handlers to AGENTS.md hard rules, and delete every self-registration surface. Without F-01, FR-005 (auth-gate) is unenforced, FR-015 (prediction blindness) has no role primitive to build on, and PRD Non-Goal #2 (no self-registration) is contradicted by live code.

## Starting Point

Today: middleware protects only `/dashboard` (allowlist of 1); auth pages live at `src/pages/auth/{signin,signup,confirm-email}.astro`; three API handlers under `src/pages/api/auth/` violate AGENTS.md hard rules (no `prerender = false`, no `zod`); `supabase/migrations/` and `supabase/seed.sql` do not exist; `[auth].enable_signup = true` in `supabase/config.toml`; sign-in redirects to `/` which 404s; no Vitest harness; no generated DB types; no `src/types.ts`.

## Desired End State

Default-deny middleware gates every route except an explicit `PUBLIC_ROUTES` list and loads `locals.profile` (with `displayName` + `roles[]`) for authed requests. The DB has `profiles` (public `display_name` + admin-only `legal_name`) and `user_roles` (strict self+admin RLS, multi-role per user) reachable via SQL helpers `is_admin()`/`is_participant()`/`current_user_roles()` and a `profiles_public` view that is the canonical non-admin read path. The single admin is seeded locally via an env-driven template and in production via Supabase Studio + a trigger reading `app.admin_email`. Self-signup is gone (4 files deleted, both config flags flipped, README cleaned). `npm test` runs Vitest integration tests against the new middleware. CI smoke (existing) keeps passing without modification.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|---|---|---|---|
| `profiles` ↔ `auth.users` shape | Normalized: `profiles` (identity) + `user_roles` (many-to-many) | `UNIQUE(user_id, role)` encodes FR-017 ("admin is also a participant") as the admin holding both rows; supports a future moderator role without schema change | Plan |
| Public-alias vs admin-only-identity | Two columns on `profiles` (`display_name` public, `legal_name` admin-only) + `profiles_public` view | One table for downstream FK simplicity; the view is the canonical non-admin read; admin reads `profiles` directly under RLS | Plan |
| Role-visibility | Strict self+admin SELECT on `user_roles` | A participant cannot identify the admin via the data layer; the leaderboard doesn't need this table | Plan |
| Auth gate model | Default-deny with `PUBLIC_ROUTES` | Verbatim PRD `## Access Control` contract; a new route is private unless deliberately exposed | Plan |
| Role enforcement | `is_admin()` + `is_participant()` + `current_user_roles()` SQL helpers (SECURITY INVOKER) | No auth-hook plumbing; RLS reads like English; matches the 5-20 user scale | Plan |
| Admin seed (local + prod) | env-driven `seed.sql.template` → generated `seed.sql` (gitignored) for local; Supabase Studio + trigger reading `app.admin_email` for prod | No password in repo; same trigger fires both envs so prod-promotion is exercised daily | Plan |
| Sign-in landing + `/` route | New `src/pages/index.astro` redirects authed → `/dashboard`; sign-in handler redirects to `/dashboard`; authed visit to `/auth/signin` redirects to `/dashboard` | Every URL has a coherent destination; signin handler currently redirects to `/` which 404s | Plan |
| DB tooling | `src/db/database.types.ts` (committed, generated) + 4 npm scripts (`db:start`, `db:stop`, `db:migration:new`, `db:types`) | Generated types separate from hand-written DTOs (`src/types.ts`); npm scripts wrap CLI ergonomics for every downstream slice | Plan |
| API hygiene | Retrofit `signin.ts` + `signout.ts` with `prerender = false` + `zod` on signin; delete `signup.ts` | Roadmap baseline explicitly scopes the AGENTS.md catch-up to F-01; signin without `prerender = false` is the production-bug AGENTS.md warns about | Plan |
| Self-signup removal scope | Delete 4 files (UI + handler + form + confirm-email) + flip both `config.toml` flags + clean README | Belt-and-suspenders: UI gone AND server-side signup refused; matches PRD Non-Goal #2 | Plan |
| Test surface for F-01 | Vitest + happy-dom + middleware integration tests (six cases) | Targets the highest-risk change (default-deny refactor); satisfies AGENTS.md "add tests before first feature merges" | Plan |

## Scope

**In scope:**

- First Supabase migration: `profiles`, `user_roles`, RLS, helper functions, `handle_new_user` trigger, `profiles_public` view, pgcrypto extension.
- npm-script harness for the Supabase CLI (`db:start`/`db:stop`/`db:migration:new`/`db:types`/`db:reset`).
- `supabase/seed.sql.template` + `scripts/seed-template.mjs` + gitignore for the generated `supabase/seed.sql`.
- Committed first generation of `src/db/database.types.ts`.
- README delta documenting local + production admin bootstrap.
- Middleware refactor: default-deny via `PUBLIC_ROUTES` + `locals.profile` loader + authed-on-signin redirect.
- New `src/pages/index.astro` (single redirect).
- Retrofit `signin.ts` (`prerender = false` + `zod` + `/dashboard` redirect) and `signout.ts` (`prerender = false`).
- `src/types.ts` introduction with `UserRole` + `Profile` DTOs.
- `src/env.d.ts` extension for `App.Locals.profile`.
- `src/lib/supabase.ts` `loadProfile` helper.
- `src/pages/dashboard.astro` displayName swap.
- Delete: `src/pages/auth/signup.astro`, `src/pages/api/auth/signup.ts`, `src/components/auth/SignUpForm.tsx`, `src/pages/auth/confirm-email.astro`.
- Flip: `[auth].enable_signup` + `[auth.email].enable_signup` in `config.toml`.
- Vitest + happy-dom harness + six middleware integration tests.
- `.github/workflows/ci.yml` `ci` job: insert `npm test` between lint and build.

**Out of scope:**

- Any per-domain tables (tournaments, matches, predictions, scores).
- Admin participant-creation UI (S-01).
- Password-change UI (S-07).
- Real `/` home page UI.
- Service-role key in the Worker runtime.
- pgTAP-style DB function unit tests.
- Edge Functions, pg_cron, observability infra.
- Documentation beyond the README delta.

## Architecture / Approach

Four ordered, independently committable phases:

```
P1: DB foundation
    └─ Single migration: profiles + user_roles + RLS + helpers + trigger + view
    └─ Seed: template (committed) + script + generated (gitignored)
    └─ Tooling: 4 npm scripts wrapping supabase CLI
    └─ Generated types: src/db/database.types.ts (committed)
    └─ README: local seed + production bootstrap docs

P2: App auth-gate refactor
    └─ Middleware: PROTECTED_ROUTES → PUBLIC_ROUTES (default-deny)
    └─ loadProfile helper in src/lib/supabase.ts
    └─ Astro.locals.profile typed in src/env.d.ts
    └─ src/types.ts (UserRole + Profile DTOs)
    └─ src/pages/index.astro (authed → /dashboard bridge)
    └─ Retrofit signin.ts (prerender + zod + redirect target) + signout.ts (prerender)
    └─ dashboard.astro: profile.displayName instead of user.email

P3: Self-signup removal
    └─ Delete: signup.astro, signup.ts, SignUpForm.tsx, confirm-email.astro
    └─ Edit signin.astro: remove "sign up" link
    └─ Flip both enable_signup flags in config.toml
    └─ Clean README

P4: Test harness
    └─ vitest + happy-dom + @vitest/coverage-v8
    └─ vitest.config.ts (path alias to mirror tsconfig)
    └─ src/middleware.test.ts: six integration tests covering the default-deny gate
    └─ npm test + npm run test:watch scripts
    └─ ci.yml: insert npm test in the ci job
```

## Phases at a Glance

| Phase | What it delivers | Key risk |
|---|---|---|
| 1. DB foundation | First migration, seed harness, npm scripts, generated types, README admin-bootstrap docs | `app.admin_email` propagation gotcha (ALTER DATABASE vs set_config) — silent admin-role-not-assigned if missed |
| 2. App auth-gate refactor | Default-deny middleware, `locals.profile` loader, index page, AGENTS.md-compliant signin/signout | A path mistakenly omitted from `PUBLIC_ROUTES` 302s an asset and breaks CI smoke or downstream slices |
| 3. Self-signup removal | 4 files gone, 2 config flags flipped, README cleaned | A lingering import of `SignUpForm` would break the build; a missed config flag would leave the auth server willing to signup |
| 4. Test harness | Vitest + happy-dom + six middleware integration tests | Mocking the Supabase client correctly in tests is fiddly — the first test file establishes the pattern downstream slices reuse |

**Prerequisites:** none — F-01 is the foundation. Roadmap `Prerequisites: —`. The repo's auto-detected baseline (Astro 6 + Cloudflare adapter + Supabase SSR client + middleware shell + CI smoke job + `wrangler.jsonc` with `nodejs_compat`) is what F-01 lands on.

**Estimated effort:** ~3-4 focused sessions across the four phases. Phase 1 is the heaviest (one migration, ~150-200 lines of SQL + npm wiring + generated types). Phases 2-4 are mechanical (refactor + delete + tests).

## Open Risks & Assumptions

- **Trigger SECURITY DEFINER permission**: the `handle_new_user` function needs DEFINER privileges to insert into `public.profiles` and `public.user_roles` from the `auth.users` insert context. If Supabase's default `postgres` role grants are tighter than expected, the migration may need an explicit `GRANT EXECUTE ON FUNCTION public.handle_new_user() TO postgres` or `service_role` clause. Verify on first `db reset`.
- **`profiles_public` view security mode**: PG 17 supports `WITH (security_invoker = true|false)`. We default to `security_invoker = false` (definer privileges) so the view bypasses underlying RLS — needed because the underlying `profiles` SELECT policy denies cross-user reads. If a future review changes this default, the leaderboard breaks silently. Documented in the migration's `COMMENT ON VIEW`.
- **Production manual step**: the production admin bootstrap requires the operator to run an `ALTER DATABASE postgres SET app.admin_email = ...` in Supabase Studio BEFORE creating the user via the UI. If they do it in the wrong order, the trigger sees an empty setting and never promotes the user. The README documents the order; a future operator-experience improvement could be a Supabase-CLI-driven bootstrap script.
- **`/api/auth/signout` listed as public**: the dashboard sign-out form posts here from an authed-but-clearing-session state. Listing it in `PUBLIC_ROUTES` avoids a refresh-token race but also means a curl `POST /api/auth/signout` from any state is accepted (no-op for an unauthed session). Acceptable for the private friend-pool threat model; called out so a security-conscious reviewer doesn't have to puzzle it out.
- **Vitest Astro middleware mocking**: the middleware imports from `@supabase/ssr`; tests need to mock the createServerClient surface cleanly. The first test file's mock pattern becomes a quasi-API for downstream test files — worth a few extra minutes to get right.

## Success Criteria (Summary)

- A new visitor hitting `https://betcup.betcup.workers.dev/<anything>` is redirected to `/auth/signin` — the FR-005 default-deny contract holds.
- Sign-in as admin → land on `/dashboard` reading "Welcome, <displayName>" (alias, not email local-part); `Astro.locals.profile.roles === ['participant', 'admin']`.
- `/auth/signup` and the entire signup surface return 404; the auth server refuses signup at the API layer too.
- `npm test` runs the middleware integration suite green; CI smoke (`/auth/signin` 200, `/dashboard` 302 unauthed) still passes; `npm run build` ships a Worker that boots clean on Cloudflare.
