# Admin Creates Participants (S-01) Implementation Plan

## Overview

Give the single admin an in-app way to create participant accounts (FR-001) so those participants can log in (FR-002). The admin opens a new `/admin/participants` surface, enters a participant's **name** (public display name) and **username** (login handle), and submits. A tightly-scoped server Action uses the Supabase **service-role** key to call `auth.admin.createUser` with an auto-generated strong password and `email_confirm: true`; the F-01 `handle_new_user` trigger then creates the `profiles` row + `participant` role automatically. The generated password is revealed once so the admin can share it out-of-band. Login switches from email-only to **username-based**, mapping `<username>` → `<username>@betcup.local` (a synthetic email the seeded admin already matches).

## Current State Analysis

Post-F-01 / post-S-02 the repo already has the scaffolding this slice rides on:

- **Identity foundation (F-01):** `public.profiles` (`id`, `display_name`, `legal_name`, timestamps) + `public.user_roles` (`user_id`, `role`) with strict RLS; SQL helpers `is_admin()`/`is_participant()`; and the **`handle_new_user` trigger** (`supabase/migrations/20260528232000_identity_boundary.sql:122`) that, on *any* `auth.users` INSERT, creates a profile (display_name from `raw_user_meta_data->>'display_name'`, else email local-part) and a `participant` role row — and an `admin` row when the email matches `app.admin_email`. **This means S-01's only real job is creating the auth user; profile + role are automatic.**
- **Mutation pattern (S-02):** Astro Actions in `src/actions/index.ts` (`server.<domain>.<verb>` via `defineAction`), with an `adminClient(context)` helper that throws `UNAUTHORIZED` for non-admins in-handler *and* relies on RLS as a backstop; an `internalError()` helper that logs the raw DB error and returns a stable generic message. Shared Zod schemas live in `src/lib/schemas/` and are imported by both the Action and the form. React islands use `react-hook-form` + `@hookform/resolvers/zod`, call `actions.<...>`, map `isInputError` to per-field errors, and `window.location.reload()` on success.
- **Admin surface:** `src/pages/admin/index.astro` (tournament admin), server-renders under the admin's cookie session and reads via RLS. Middleware (`src/middleware.ts:12`) already gates `/admin` (and thus `/admin/*`) to admins via `ADMIN_ROUTES`. The dashboard (`src/pages/dashboard.astro:18`) shows a "Tournament admin" link to admins.
- **Auth client:** `src/lib/supabase.ts` builds an SSR anon client (`createServerClient<Database>`) keyed on `SUPABASE_KEY` (the **anon** key). `loadProfile()` maps DB rows → the `Profile` DTO (`src/types.ts`).
- **Sign-in:** `src/pages/api/auth/signin.ts` validates `{ email, password }` with zod and calls `signInWithPassword`. `src/components/auth/SignInForm.tsx` is an email-labelled island with an email regex. The seeded admin's email is `admin@betcup.local` (`.env.example:6`).
- **Env schema:** `astro.config.mjs:17-22` declares only `SUPABASE_URL` + `SUPABASE_KEY` as server secrets via `astro:env/server`. There is **no service-role key** wired anywhere — F-01 deliberately kept it out of the Worker.

### Key Discoveries

- `auth.admin.createUser` **requires the service-role (secret) key** — "all `admin` methods expect a `SERVICE_ROLE` key" (Supabase docs via Context7). It must run in a server-only client built with `persistSession: false`.
- A direct `auth.users` INSERT (the service-role-free alternative) also needs a hand-built `auth.identities` row or sign-in fails — see `supabase/seed.sql.template:62-80`. `auth.admin.createUser` creates both automatically, which is why it's the chosen path (protects FR-002).
- The `handle_new_user` trigger keys admin promotion off `app.admin_email`, and only ever adds `participant` for non-matching emails — so a created participant is structurally guaranteed to be participant-only. No code path in this slice can mint a second admin.
- The synthetic email domain `betcup.local` already matches the F-01 admin seed (`admin@betcup.local`), so the seeded admin logs in as username `admin` with zero migration.

## Desired End State

- The admin visits `/admin/participants`, sees a list of existing participants (name + username), fills in name + username, and submits.
- On success a panel reveals the participant's **username + generated password** with a copy control; the admin shares them out-of-band.
- The created participant signs in at `/auth/signin` by typing their **username** + that password, and lands on `/dashboard`.
- A non-admin who reaches the Action (e.g. crafted POST to `/_actions/participants.create`) is refused; a non-admin cannot reach `/admin/participants` (middleware redirect).
- A duplicate username yields a friendly field-level "That username is taken", not a raw DB error.
- `npm run lint`, `npm run build`, `npm run check:wrangler`, and `npm test` all pass; integration tests prove create→login and the admin-only guard.

### Verification

- `npm test` passes new unit tests (`participant` schema, password generator) and integration tests (admin-creates → participant-signs-in; non-admin denied; duplicate friendly error).
- Manual: create a participant locally, sign out, sign in as that participant by username → `/dashboard`.

## What We're NOT Doing

- **No participant deletion** — FR-004 is S-06. (The list rows are read-only here; S-06 adds the delete control.)
- **No password change / reset** — FR-003 is S-07. The generated password is one-shot; if lost before sharing, S-07's reset (not yet built) is the recovery path, so the admin must copy it from the reveal panel.
- **No editing a participant's name/username after creation** — out of scope; not in FR-001/FR-002.
- **No second admin / role management UI** — the single-admin invariant from F-01 stands; this slice only ever creates `participant`s.
- **No email delivery / confirmation flow** — usernames map to synthetic, non-routable emails; `email_confirm: true` skips confirmation. (Consistent with PRD Non-Goal: notifications.)
- **No real email login** beyond a defensive passthrough for the seeded admin (see Critical Implementation Details).
- **Not re-enabling self-signup** — `enable_signup` stays `false`; creation is admin-only via service-role.

## Implementation Approach

Bottom-up, mirroring F-01/S-02 so each phase is independently reviewable and committable:

1. **Data layer** lands a migration adding `profiles.username` (unique, case-insensitive), backfills the admin, and extends `handle_new_user` to populate it from user-metadata; regenerates types.
2. **Server layer** adds the service-role env + isolated admin-auth client, the password generator, the `participant` schema, the `participants.create` Action, and the username→synthetic-email switch in sign-in; unit-tests the pure pieces.
3. **UI layer** relabels sign-in to username, builds the `/admin/participants` page + create-island with the reveal-once panel, and adds navigation.
4. **Integration tests + CI** prove the end-to-end create→login path, the admin-only guard, and the duplicate-username message against a local Supabase.

Defense-in-depth throughout: the Action checks admin in-handler; RLS backstops every anon-client read; the service-role client is confined to one module imported only by the create Action and used only for `auth.admin.createUser` (never for prediction reads — the FR-015 risk the roadmap flags).

## Critical Implementation Details

- **Service-role isolation is the load-bearing constraint.** `src/lib/supabase-admin.ts` is the *only* module that reads `SUPABASE_SERVICE_ROLE_KEY`, and `participants.create` is the *only* importer. The client is built with `auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }` so it never touches the request's cookies/session. It must never be used to read `predictions` (or any per-user data) — misuse here is the single most likely path to an FR-015 blindness leak (per roadmap S-01 risk). A module-level comment states this; the impl-review should assert no second importer exists.
- **Username → synthetic email mapping must be identical on both sides.** Create and sign-in both compute `synthEmail(username) = \`${username.trim().toLowerCase()}@betcup.local\``. Put this in one shared helper (`src/lib/username.ts`) imported by both `participants.create` and `signin.ts` so they can never drift. Drift = "created but can't log in".
- **Sign-in admin passthrough.** `signin.ts` treats an input containing `@` as a literal email (passthrough), otherwise applies `synthEmail()`. This guarantees the seeded admin keeps working even if a future `ADMIN_EMAIL` doesn't end in `@betcup.local`, while participants use bare usernames. Invisible to participants.
- **Reveal-once means no auto-reload on success.** Unlike the S-02 forms (which `window.location.reload()` immediately), `ParticipantForm` must keep the success panel mounted so the generated password stays visible. The list refresh happens only when the admin clicks "Create another / Done" (which resets + reloads). Reloading immediately would destroy the only copy of the password.
- **Password generation uses Web Crypto.** `crypto.getRandomValues` (available in workerd and Node 22) over a fixed unambiguous alphabet; never `Math.random`. The password is returned in the Action's JSON response (over the admin's authed HTTPS session) — it is never stored in plaintext and never logged.
- **Duplicate detection (confirm the contract before coding the branch).** `auth.admin.createUser` returns an error for an already-registered email; map it to a `BAD_REQUEST` Action error on the `username` field. The exact discriminator (`error.code === "email_exists"` vs. `error.status === 422`) is **not yet verified** — confirm it once against the local stack first: in a throwaway run (or a temporary `console.error(JSON.stringify(error))` in the existing `matches.rls` harness, which already calls `admin.auth.admin.createUser`), create a duplicate email and read the real `code`/`status`. Pin that literal in the handler and assert it in the Phase 4 duplicate test so a GoTrue change can't regress it silently. Any other error → the generic `internalError()` path. Never surface the raw GoTrue message (it would reveal the synthetic-email scheme). Note: because username↔email is 1:1, a true duplicate trips this `createUser` error *before* the trigger runs; the `profiles_username_lower_idx` unique constraint only surfaces (as a different, 500-shaped error routed to `internalError`) in the edge case where a stored username diverges from its email local-part.
- **Trigger edit is additive.** `handle_new_user` gains a `username` write; the existing display_name/role logic is untouched. `set search_path = public` and `SECURITY DEFINER` are preserved exactly.

## Phase 1: Data layer — username column + trigger + types

### Overview

Add a `username` identity field to `profiles`, enforce case-insensitive uniqueness, backfill existing rows (the admin), extend `handle_new_user` to populate it, and regenerate the typed DB client.

### Changes Required

#### 1. Migration

**File**: `supabase/migrations/<YYYYMMDDHHmmss>_participant_username.sql` (new — generate name via `npm run db:migration:new participant_username`)

**Intent**: Make `username` a first-class, uniquely-constrained column on `profiles` so the admin participant list can render it under existing RLS (no service-role read needed) and uniqueness is explicit; teach the trigger to fill it.

**Contract**: A single migration containing, in order:

1. `alter table public.profiles add column username text;`
2. Backfill: `update public.profiles p set username = lower(split_part(u.email, '@', 1)) from auth.users u where u.id = p.id and p.username is null;`
3. `create unique index profiles_username_lower_idx on public.profiles (lower(username));`
4. `alter table public.profiles alter column username set not null;` (safe after backfill — every existing row is an admin/seeded user with an email).
5. `comment on column public.profiles.username is 'Login handle (lowercased). Maps to the synthetic auth email <username>@betcup.local. Unique case-insensitively.';`
6. `create or replace function public.handle_new_user()` — identical body to the F-01 version (`SECURITY DEFINER`, `set search_path = public`, same display_name + role logic) **plus** writing `username` into the `profiles` insert: `lower(coalesce(nullif(new.raw_user_meta_data->>'username',''), split_part(new.email,'@',1)))`. The `lower(...)` wraps the **whole** coalesce (both the metadata and the email-fallback branch) so a mixed-case `user_metadata.username` from the Studio "Add user" path is stored lowercased too — keeping the stored value consistent with the case-insensitive login mapping and the `lower(username)` unique index. The trigger itself does not need re-creating (it already points at the function).

No RLS changes: `profiles_select` already lets the admin read all rows and a user read their own, which covers the list.

#### 2. Regenerated types

**File**: `src/db/database.types.ts` (regenerate)

**Intent**: Reflect the new `profiles.username` column so the Action and page are typed.

**Contract**: Run `npm run db:reset` (re-applies migrations + seed) then `npm run db:types`; commit the diff (a `username: string` field on the `profiles` Row/Insert/Update types).

### Success Criteria

#### Automated Verification

- Migration applies cleanly: `npm run db:reset` completes without error.
- Types regenerate: `npm run db:types` exits 0 and `profiles` gains a `username` field.
- Type-check/lint clean: `npx astro sync && npm run lint`.
- After reset, the admin row has a non-null `username` (`= 'admin'`): `psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -c "select username from public.profiles;"`.

#### Manual Verification

- In Supabase Studio, `profiles` shows the `username` column NOT NULL with a unique (lowercased) index.
- Inserting a second `auth.users` row (Studio "Add user") with `user_metadata.username` populates `profiles.username` from that metadata.

**Implementation Note**: After automated verification passes, pause for manual confirmation of the schema + trigger behavior before starting Phase 2.

---

## Phase 2: Server layer — service-role client, Action, schema, sign-in mapping

### Overview

Wire the service-role env var, add the isolated admin-auth client, the password generator, the shared `participant` schema and `synthEmail` helper, the `participants.create` Action, and switch the sign-in handler to username→synthetic-email. Unit-test the pure pieces.

### Changes Required

#### 1. Service-role env

**File**: `astro.config.mjs` (edit)

**Intent**: Declare `SUPABASE_SERVICE_ROLE_KEY` as a server-only secret so it's read via `astro:env/server`, never the client.

**Contract**: Add to the `env.schema` block: `SUPABASE_SERVICE_ROLE_KEY: envField.string({ context: "server", access: "secret", optional: true })`. Optional so the build (which has no DB) and CI still pass without it.

**File**: `.env.example` (edit) and `.dev.vars` (operator-local, gitignored — document only)

**Intent**: Signal the new variable. Locally it's the `service_role` key printed by `npx supabase start`.

**Contract**: Append to `.env.example`: `SUPABASE_SERVICE_ROLE_KEY=###` with a one-line comment that it's required only for admin participant creation and must never reach the client.

#### 2. Isolated service-role auth client

**File**: `src/lib/supabase-admin.ts` (new)

**Intent**: The single sanctioned home for the service-role key. Exposes a factory that returns a non-session-persisting admin client used only for `auth.admin.createUser`.

**Contract**: `export function createAdminAuthClient(): SupabaseClient<Database> | null`. Reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `astro:env/server`; returns `null` if either is missing. Builds `createClient<Database>(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })` (from `@supabase/supabase-js`, not `@supabase/ssr` — no cookies). A prominent module comment: this key bypasses RLS; this module must have exactly one importer (`participants.create`); never use it to read participant data (FR-015).

#### 3. Username helper

**File**: `src/lib/username.ts` (new)

**Intent**: Single source of truth for the username→email mapping so create and sign-in cannot drift.

**Contract**: `export const SYNTHETIC_EMAIL_DOMAIN = "betcup.local";` and `export function synthEmail(username: string): string` returning `\`${username.trim().toLowerCase()}@${SYNTHETIC_EMAIL_DOMAIN}\``.

#### 4. Password generator

**File**: `src/lib/password.ts` (new)

**Intent**: Cryptographically strong initial-password generator.

**Contract**: `export function generatePassword(length = 16): string` using `crypto.getRandomValues` over an unambiguous alphabet (no `0/O/1/l/I`), guaranteeing at least one lower, one upper, and one digit. Pure, deterministic only in shape (not value); no logging.

#### 5. Participant schema

**File**: `src/lib/schemas/participant.ts` (new)

**Intent**: Shared validation for the create form and Action (no password field — it's generated).

**Contract**:
```ts
export const participantCreateSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  username: z
    .string()
    .trim()
    .toLowerCase()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(/^[a-z0-9._-]+$/, "Use lowercase letters, digits, dot, underscore or hyphen"),
});
export type ParticipantCreateInput = z.infer<typeof participantCreateSchema>;
```

#### 6. `participants.create` Action

**File**: `src/actions/index.ts` (edit — add a `participants` namespace to `server`)

**Intent**: Admin-only participant creation. Reuse the existing in-handler admin guard pattern; use the service-role client solely for `auth.admin.createUser`; return the username + generated password once.

**Contract**: New `server.participants.create = defineAction({ accept: "json", input: participantCreateSchema, handler })` where the handler:
1. Extract the role check from `adminClient` into a shared `function requireAdmin(locals: App.Locals): void` (throws `UNAUTHORIZED` "Admin access required" when `!locals.profile?.roles.includes("admin")`), refactor `adminClient` to call it, and call `requireAdmin(context.locals)` here. Do **not** call `adminClient(context)` in this handler — it would build an anon SSR client this Action never uses (creation goes through the service-role client; nothing is written via the anon client).
2. `const admin = createAdminAuthClient();` → `INTERNAL_SERVER_ERROR` (`NOT_CONFIGURED`) if null.
3. `const password = generatePassword();`
4. `await admin.auth.admin.createUser({ email: synthEmail(input.username), password, email_confirm: true, user_metadata: { display_name: input.name, username: input.username } })`.
5. On error: if it indicates an already-registered email (the **confirmed** discriminator from Critical Implementation Details — `error.code === "email_exists"` or status 422, verified against the local stack first), throw `new ActionError({ code: "BAD_REQUEST", message: "That username is taken." })` **with the field path on `username`** (use `INPUT` semantics — return a field error so `isInputError` maps it). Otherwise `throw internalError(error)`.
6. Return `{ username: input.username, password }`.

Note: the trigger creates the profile (with `username` from metadata) + `participant` role — the Action writes nothing to `profiles`/`user_roles` directly.

#### 7. Sign-in username mapping

**File**: `src/pages/api/auth/signin.ts` (edit)

**Intent**: Accept a username (FR-002) and map to the synthetic email; keep an `@`-passthrough for the seeded admin.

**Contract**: Rename the schema field `email` → `login` (`z.string().trim().min(1)`); keep `password`. Resolve `const email = parsed.data.login.includes("@") ? parsed.data.login : synthEmail(parsed.data.login);` then `signInWithPassword({ email, password })`. Error/redirect behavior unchanged. (Generic "Invalid credentials" on failure — don't reveal whether the username exists.)

#### 8. Unit tests

**Files**: `src/lib/password.test.ts`, `src/lib/schemas/participant.test.ts` (new)

**Intent**: Pin the two pure pieces.

**Contract**: Password — length, charset (no ambiguous chars), presence of each required class, and that repeated calls differ. Schema — accepts valid handles, lowercases input, rejects too-short/too-long/illegal-char usernames and empty names.

### Success Criteria

#### Automated Verification

- Lint/type-check clean: `npx astro sync && npm run lint`.
- Build passes: `npm run build`.
- `check:wrangler` passes: `npm run check:wrangler`.
- Unit tests pass: `npm test` (password + participant-schema suites green).
- `SUPABASE_SERVICE_ROLE_KEY` is read in exactly one module: `rg "SUPABASE_SERVICE_ROLE_KEY" src` returns only `src/lib/supabase-admin.ts`.
- `createAdminAuthClient` has exactly one importer: `rg "supabase-admin" src` returns only `src/actions/index.ts`.

#### Manual Verification

- With the local `service_role` key in `.dev.vars`, the Action is reachable; without it, the Action returns the generic not-configured error (no crash).

**Implementation Note**: After automated verification, pause for manual confirmation that the service-role key is isolated (the two `rg` checks) before starting Phase 3.

---

## Phase 3: UI layer — username sign-in, /admin/participants page + island

### Overview

Relabel the sign-in form to "Username", build the `/admin/participants` page (server-rendered participant list + create section), the `ParticipantForm` island with the reveal-once password panel, and a nav link.

### Changes Required

#### 1. Sign-in form relabel

**File**: `src/components/auth/SignInForm.tsx` (edit)

**Intent**: The login field is now a username, not an email.

**Contract**: Rename the field/state `email` → `login`; label "Username"; `name="login"`; placeholder e.g. `your-username`; swap the email regex for a non-empty check (lowercasing is applied server-side and via the schema); keep the password field, toggle, and `ServerError`. Input `type="text"`. The icon can switch from `Mail` to `User`.

#### 2. Participant create form island

**File**: `src/components/admin/ParticipantForm.tsx` (new)

**Intent**: Admin-facing create form using the established rhf + zodResolver + Action pattern, with a reveal-once success panel.

**Contract**: `react-hook-form` with `zodResolver(participantCreateSchema)`, fields `name` + `username` (shadcn `Form`/`FormField`/`Input`, mirroring `TournamentForm.tsx`). On submit call `actions.participants.create(values)`. On `isInputError` map field errors (the duplicate-username message lands on `username`); else set a server-error string. **On success**, store `{ username, password }` in state and render a reveal panel (username + password monospace + a "Copy" button using `navigator.clipboard`) plus a "Create another" button that clears the panel, resets the form, and `window.location.reload()`s to refresh the list. Do **not** auto-reload.

#### 3. Participants admin page

**File**: `src/pages/admin/participants.astro` (new)

**Intent**: The `/admin/participants` surface: list existing participants + the create form. Server-rendered under the admin session (RLS lets the admin read all profiles).

**Contract**: Mirror `admin/index.astro`'s server block: `createClient(...)`, then `supabase.from("profiles").select("display_name, username").neq("id", Astro.locals.user.id).order("created_at", { ascending: true })`; on error return a 500 `Response` (don't render an empty list as "no participants"). The `.neq("id", Astro.locals.user.id)` excludes the admin's **own** row — without it the admin (who also holds the participant role per FR-017, username `admin`) renders inside a list labelled "existing participants", which is confusing and would let S-06's future delete control target the admin row. (The single-admin invariant means the current user is the only admin, so excluding self == excluding admin.) Render a `<Layout>` with a heading, a read-only list/table (name + username), and a `<section>` mounting `<ParticipantForm client:load />`. Admin-only is already enforced by middleware `ADMIN_ROUTES`.

#### 4. Navigation link

**File**: `src/pages/dashboard.astro` (edit) and/or `src/pages/admin/index.astro` (edit)

**Intent**: Make the new page reachable.

**Contract**: Add an admin-only "Participants" link (same styled-anchor pattern as the existing "Tournament admin" link in `dashboard.astro:18-25`) pointing to `/admin/participants`. Optionally cross-link from `admin/index.astro`.

### Success Criteria

#### Automated Verification

- Lint/type-check clean: `npx astro sync && npm run lint`.
- Build passes: `npm run build`.
- `check:wrangler` passes.

#### Manual Verification

- As admin, `/admin/participants` lists existing participants and shows the create form.
- Creating a participant shows the reveal panel with username + a strong password and a working Copy button; the list does NOT vanish/reload until "Create another".
- A non-admin visiting `/admin/participants` is redirected to `/dashboard`.
- The sign-in form shows a "Username" field (not "Email").
- Submitting an invalid username (too short / illegal chars) shows the inline field error before any server round-trip.

**Implementation Note**: After automated verification, pause for manual confirmation of the four UI behaviors before starting Phase 4.

---

## Phase 4: Integration tests + CI

### Overview

Prove the end-to-end behavior against a local Supabase: admin creates a participant who can then sign in, a non-admin is refused, and a duplicate username yields the friendly error.

### Changes Required

#### 1. Action integration tests

**File**: `src/actions/participants.test.ts` (new)

**Intent**: Cover the security-critical behaviors that unit tests can't (FR-001 + FR-002 together, plus the guard).

**Contract**: Against the local Supabase stack (service-role key from env), exercise the `participants.create` handler (or a thin testable wrapper around it):
1. **Admin creates → participant signs in**: as admin, create `{ name, username }`; assert the returned password is non-empty; then build an anon SSR-style client and `signInWithPassword({ email: synthEmail(username), password })` succeeds and the resulting user has a `participant` role (and not `admin`).
2. **Non-admin denied**: invoke the handler with a non-admin `locals.profile`; assert `UNAUTHORIZED`.
3. **Duplicate username**: create the same username twice; assert the second throws a `BAD_REQUEST` **input** error on `username` ("That username is taken.") — this is the test that pins the GoTrue duplicate-error contract confirmed in Phase 2, so a future GoTrue change that alters the error shape fails here instead of silently falling through to the generic error.
4. Cleanup created users (service-role `auth.admin.deleteUser`) in an `afterEach`/`afterAll` so reruns stay clean.

Follow the harness shape established by S-02's RLS/integration tests (`matches.rls.test.ts` if present); reuse its local-DB bootstrap. If the existing harness is mock-only and a local-DB lane needs a small addition, add it minimally and note it (lessons.md: name support files in the plan).

#### 2. CI

**File**: `.github/workflows/ci.yml` (verify / edit only if needed)

**Intent**: Ensure the new tests run. `npm test` is already wired into the `ci` job (F-01 Phase 4).

**Contract**: If the integration tests require a local Supabase in CI that isn't already provisioned, gate them to run locally and document that (don't add a Supabase service to CI in this slice unless trivial); the unit tests + admin-guard test (mockable) must run in CI regardless. Prefer keeping CI green without a DB by structuring the create→login test to skip cleanly when `SUPABASE_SERVICE_ROLE_KEY` is absent, while running fully locally.

### Success Criteria

#### Automated Verification

- `npm test` passes locally with the full suite (unit + integration) when `SUPABASE_SERVICE_ROLE_KEY` is set.
- `npm test` stays green in CI (integration tests skip cleanly when the service-role key is absent; unit + guard tests run).
- Lint + build still pass.

#### Manual Verification

- Full manual loop: create participant `bob` → sign out → sign in as `bob` with the revealed password → `/dashboard`. Then attempt to create `bob` again → "That username is taken."
- CI run on the PR is green (existing `smoke` + `ci` jobs).

**Implementation Note**: After Phase 4, pause for manual confirmation of the full create→login loop before considering S-01 complete.

---

## Testing Strategy

### Unit Tests

- `generatePassword`: length, unambiguous charset, required character classes, value variance.
- `participantCreateSchema`: lowercasing, accepted/rejected handles, name bounds.

### Integration Tests

- Admin-creates → participant-signs-in (the joint FR-001+FR-002 proof).
- Non-admin caller refused (admin-only guard).
- Duplicate username → friendly field error.

### Manual Testing Steps

1. `npm run db:reset` (admin seeded, `username='admin'`), set `SUPABASE_SERVICE_ROLE_KEY` in `.dev.vars`, `npm run dev`.
2. Sign in as `admin` → `/dashboard` → "Participants".
3. Create `{ name: "Bob R", username: "bob" }` → reveal panel shows `bob` + a strong password; Copy works.
4. "Create another", confirm `bob` now appears in the list.
5. Sign out; sign in as `bob` + the copied password → `/dashboard`.
6. Back as admin, try creating `bob` again → inline "That username is taken." on the username field.
7. As `bob` (non-admin), visit `/admin/participants` → redirected to `/dashboard`.

## Performance Considerations

Negligible at the 5–20-user scale: one `auth.admin.createUser` round-trip per creation, one indexed `profiles` SELECT per page load. The unique `lower(username)` index keeps duplicate detection and login mapping cheap.

## Migration Notes

- **Username/email coupling.** Login resolves `username` → `<username>@betcup.local`. The seeded admin (`admin@betcup.local`) logs in as `admin`. If an operator's `ADMIN_EMAIL` does not end in `@betcup.local`, the `@`-passthrough in sign-in lets them still log in with their full email; document this in the README admin section.
- **Production service-role secret** is an operator step: `npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY` (Workers runtime secret) and the local `service_role` key in `.dev.vars`. It is **not** a build-time secret (env field is `optional`). Rotating it is sensitive but not currently in AGENTS.md's manual-approval list; treat it with the same care as `SUPABASE_KEY`.
- **Supabase migrations don't roll back with the Worker** (AGENTS.md). This migration is additive (a new nullable→backfilled→NOT NULL column + a trigger function replace); reverting the Worker does not require reverting it, and the column is harmless if left in place.

## References

- Change folder: `context/changes/admin-creates-participants/`
- Roadmap: `context/foundation/roadmap.md` S-01 (`:81-92`) — outcome, the service-role unknown, the FR-015 risk.
- PRD: `context/foundation/prd.md` — FR-001/FR-002 (`:80-81`), Access Control (`:131-140`, no self-registration, admin sets initial password shared out-of-band).
- F-01 (the foundation this rides on): `context/archive/2026-05-28-identity-boundary/plan.md`; trigger + RLS in `supabase/migrations/20260528232000_identity_boundary.sql`.
- S-02 patterns to mirror: `src/actions/index.ts` (Actions + admin guard + `internalError`), `src/lib/schemas/tournament.ts`, `src/components/admin/TournamentForm.tsx`, `src/pages/admin/index.astro`.
- Service-role requirement + non-session client: Supabase docs via Context7 (`auth.admin.*` needs `SERVICE_ROLE`).
- Synthetic-email/identity precedent: `supabase/seed.sql.template:62-80`.
- AGENTS.md hard rules: `prerender = false`, `astro:env/server` for server secrets, RLS-by-default, `zod` validation, `cn()`, shadcn-only UI primitives.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Data layer — username column + trigger + types

#### Automated

- [x] 1.1 Migration applies cleanly: `npm run db:reset` completes without error — 0e4f62b
- [x] 1.2 Types regenerate: `npm run db:types` exits 0 and `profiles` gains a `username` field — 0e4f62b
- [x] 1.3 Type-check/lint clean: `npx astro sync && npm run lint` — 0e4f62b
- [x] 1.4 After reset, the admin row has a non-null `username` (`= 'admin'`) — 0e4f62b

#### Manual

- [x] 1.5 Studio: `profiles.username` is NOT NULL with a unique lowercased index — 0e4f62b
- [x] 1.6 A new user created with `user_metadata.username` populates `profiles.username` — 0e4f62b

### Phase 2: Server layer — service-role client, Action, schema, sign-in mapping

#### Automated

- [x] 2.1 Lint/type-check clean: `npx astro sync && npm run lint`
- [x] 2.2 Build passes: `npm run build`
- [x] 2.3 `check:wrangler` passes
- [x] 2.4 Unit tests pass: `npm test` (password + participant-schema suites)
- [x] 2.5 `SUPABASE_SERVICE_ROLE_KEY` read in exactly one module (`rg` returns only `src/lib/supabase-admin.ts`)
- [x] 2.6 `createAdminAuthClient` has exactly one importer (`rg` returns only `src/actions/index.ts`)

#### Manual

- [x] 2.7 Action reachable with the local service-role key; returns generic not-configured error without it (no crash)

### Phase 3: UI layer — username sign-in, /admin/participants page + island

#### Automated

- [ ] 3.1 Lint/type-check clean: `npx astro sync && npm run lint`
- [ ] 3.2 Build passes: `npm run build`
- [ ] 3.3 `check:wrangler` passes

#### Manual

- [ ] 3.4 `/admin/participants` lists participants and shows the create form (as admin)
- [ ] 3.5 Create shows the reveal panel (username + strong password + working Copy); list does not reload until "Create another"
- [ ] 3.6 Non-admin visiting `/admin/participants` is redirected to `/dashboard`
- [ ] 3.7 Sign-in form shows a "Username" field
- [ ] 3.8 Invalid username shows an inline field error before any server round-trip

### Phase 4: Integration tests + CI

#### Automated

- [ ] 4.1 `npm test` passes full suite locally with `SUPABASE_SERVICE_ROLE_KEY` set
- [ ] 4.2 `npm test` stays green in CI (integration skips cleanly without the service-role key; unit + guard run)
- [ ] 4.3 Lint + build still pass

#### Manual

- [ ] 4.4 Full loop: create `bob` → sign out → sign in as `bob` → `/dashboard`; re-create `bob` → "That username is taken."
- [ ] 4.5 CI run on the PR is green (`smoke` + `ci` jobs)
