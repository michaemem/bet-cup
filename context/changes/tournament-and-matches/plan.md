# Tournament & Matches (S-02) Implementation Plan

## Overview

Let the single admin create the one tournament (name + timezone), populate its
match list either one-by-one (home / away / kickoff) or by pasting a multi-line
fixture list with a parsed, inline-editable preview before confirm, and edit any
match's teams or kickoff up until that match kicks off. Every surface is
admin-only. Kickoff times are stored UTC-correct (`timestamptz`) so they can drive
S-03's blindness lock and S-04's scoring without timezone drift.

## Current State Analysis

F-01 (`identity-boundary`) is fully landed and is the foundation this slice rides:

- **DB**: `public.profiles` + `public.user_roles` + the `public.user_role` enum,
  with strict per-operation RLS, the SECURITY DEFINER `is_admin()` /
  `is_participant()` / `current_user_roles()` helpers, the `handle_new_user`
  trigger, and the `profiles_public` view
  (`supabase/migrations/20260528232000_identity_boundary.sql`). No application
  tables beyond identity exist yet.
- **Auth/session**: `src/middleware.ts` is a default-deny gate that sets
  `context.locals.user` and `context.locals.profile` (with `roles: UserRole[]`)
  on every request. It does **not** yet distinguish admin from participant at the
  route level — S-02 introduces the first admin-only route surface.
- **Mutation pattern today**: plain API routes (`src/pages/api/auth/signin.ts`):
  `export const prerender = false` + `zod` + `request.formData()` → `redirect`.
  No `src/actions/` directory exists yet.
- **DB tooling**: `npm run db:migration:new`, `db:types`, `db:reset` wrap the
  Supabase CLI; `src/db/database.types.ts` is generated + committed.
- **Tests**: Vitest + happy-dom harness with `src/middleware.test.ts` establishing
  the Supabase-client mock pattern.
- **UI deps present**: `zod@^4.4.3`, React 19, Tailwind 4, `lucide-react`, the
  shadcn pipeline (only `button.tsx` exists so far), `@supabase/ssr`. Astro 6
  ships Actions built-in.

### Key Discoveries:

- Admin holds both `participant` and `admin` `user_roles` rows; the in-handler
  admin check is `context.locals.profile?.roles.includes("admin")`
  (`src/types.ts:9`, `src/middleware.ts:40`).
- `is_admin()` is callable from RLS policies and reads the caller's own roles
  without recursion (`...identity_boundary.sql:82`) — reuse it for S-02 table RLS.
- The `set_updated_at()` trigger function already exists and is reusable for the
  new tables' `updated_at` columns (`...identity_boundary.sql:31`).
- workerd's `Date` is always UTC server-side (research §4); never trust a server
  `new Date()` to carry a wall-clock zone — convert explicitly with `@date-fns/tz`.
- `@hookform/resolvers`' `zodResolver` supports Zod 4 directly; no downgrade
  (research "Vendor docs"). Use `Controller`/`FormField` for the controlled date
  picker, not `register`.
- Papa Parse string parsing is **synchronous** — `Papa.parse(text, config)`
  returns `{ data, errors, meta }` directly; clean fit for parse→preview→confirm.

## Desired End State

The admin signs in, lands on an admin area, and:

- Creates the tournament with a name and a timezone (defaulting to their browser
  zone); re-visiting shows an edit form for the existing tournament (no second
  tournament can be created).
- Adds a match via a form (home team, away team, kickoff date + time) entered in
  the tournament timezone; it persists with the correct UTC instant.
- Pastes a fixture list, sees each line parsed into an editable preview row marked
  valid / error (with the reason) and past-kickoff rows visibly warned, fixes any
  bad rows inline, and confirms — all rows save in one atomic batch.
- Edits a match's teams or kickoff while its kickoff is still in the future; after
  kickoff the edit is refused at both the app layer (friendly message) and the DB
  (RLS), and the UI marks the match locked.

Verify: a non-admin (or unauthenticated) request to any admin route redirects /
is denied; a match write by a non-admin is denied by RLS; an edit to a
past-kickoff match is denied; a kickoff entered as "18:00 Europe/Warsaw" stores
the matching UTC instant and renders back as 18:00.

## What We're NOT Doing

- **No result columns / scoring** — entering results (FR-009/010), the 3/2/1/0
  scoring (FR-018), and the leaderboard (FR-020) are **S-04**. The `matches`
  schema here carries no `home_score`/`away_score`; S-04 adds them via its own
  migration.
- **No predictions** — the `predictions` table, blindness RLS, and the kickoff
  lock for *participants* are **S-03**. This slice's `matches` RLS is admin-only;
  S-03 opens participant read.
- **No participant-facing match list UI** — FR-011's participant view lands in S-03.
- **No multi-tournament support** — single tournament only (PRD Non-Goal);
  enforced at the app layer, not the schema.
- **No DB-level singleton constraint**, no per-match timezone, no natural-language
  date entry, no `chrono-node`.

## Implementation Approach

Four ordered, independently committable phases, bottom-up: DB first (so types and
RLS exist for everything above), then the server mutation layer (Actions + shared
schemas + the timezone and parser utilities), then the one-by-one UI, then the
bulk-paste import that reuses the same Action and schemas.

Mutations use **Astro Actions** (`src/actions/index.ts`) — a new pattern alongside
the existing auth API routes, chosen for type-safe island calls and first-class
per-field Zod errors. Because Actions are public endpoints (`/_actions/<name>`),
every handler re-checks admin in-handler **and** the DB enforces admin via RLS
(defense-in-depth, mirroring F-01's posture). The edit-before-kickoff cutoff is
likewise enforced twice: an RLS `UPDATE` policy `USING (kickoff_time > now())` is
the source of truth, with an app-layer pre-check for a friendly message.

Timezone: the tournament owns a single IANA `time_zone`. The admin enters
wall-clock date+time; `@date-fns/tz`'s `TZDate` converts that to the correct UTC
instant for `timestamptz` storage, and re-projects UTC back into the tournament
zone for display.

## Critical Implementation Details

- **workerd Date is UTC** — never construct kickoff from a bare `new Date(y,m,d,h,m)`
  on the server expecting it to mean the admin's local time. Always go through
  `TZDate(..., tournamentZone)` (research §4 / Vendor docs). `TZDate.getTimezoneOffset()`
  returns the inverted sign; use standalone `tzOffset()` if an offset is needed.
- **Action admin check + RLS both required** — `context.locals.profile` is set by
  middleware and is available inside Action handlers (Actions run through
  middleware). The in-handler check gives a clean `UNAUTHORIZED`; RLS is the
  bypass-proof backstop. Neither alone is sufficient.
- **Papa Parse is synchronous for strings** — call it in the browser island, hand
  each `data` row to the Zod `matchRowSchema` (which performs the TZ conversion +
  `kickoff > now()` evaluation for the warning flag). Papa handles only delimited
  structure; business rules are Zod's job.
- **Singleton create-or-edit** — `tournament.upsert` must read whether a row
  exists and update-or-insert accordingly; the UI shows "create" vs "edit" based
  on the same existence check. No DB constraint enforces this, so the Action is
  the only writer that must respect it.

## Phase 1: Data layer

### Overview

Add the `tournaments` and `matches` tables with admin-only RLS and the
edit-before-kickoff lock, regenerate DB types, and pin the RLS boundary with an
integration test.

### Changes Required:

#### 1. Migration: tournaments + matches

**File**: `supabase/migrations/<timestamp>_tournament_and_matches.sql` (create via
`npm run db:migration:new tournament_and_matches`)

**Intent**: Establish the two domain tables this slice owns, with admin-only
access and a DB-enforced edit lock, reusing F-01's `is_admin()` and
`set_updated_at()`.

**Contract**:
- `public.tournaments`: `id uuid pk default gen_random_uuid()`, `name text not null`,
  `time_zone text not null` (IANA name), `created_at`/`updated_at timestamptz not null default now()`.
- `public.matches`: `id uuid pk default gen_random_uuid()`,
  `tournament_id uuid not null references public.tournaments(id) on delete cascade`,
  `home_team text not null`, `away_team text not null`,
  `kickoff_time timestamptz not null`, `created_at`/`updated_at` as above.
  Index on `(tournament_id, kickoff_time)`.
- `updated_at` triggers on both tables using the existing `public.set_updated_at()`.
- RLS enabled on both. Policies (all `to authenticated`):
  - `SELECT` / `INSERT` / `DELETE`: `using/with check (public.is_admin())`.
  - `matches` `UPDATE`: `using (public.is_admin() and kickoff_time > now())
    with check (public.is_admin())` — this is the FR-008 source of truth.
  - `tournaments` `UPDATE`: `using (public.is_admin()) with check (public.is_admin())`.
- No `home_score`/`away_score` columns (S-04).

#### 2. Regenerate DB types

**File**: `src/db/database.types.ts`

**Intent**: Refresh the committed generated types so Actions and the Supabase
client are typed against the new tables.

**Contract**: Run `npm run db:reset` then `npm run db:types`; commit the diff.
`Database["public"]["Tables"]` gains `tournaments` and `matches`.

#### 3. RLS / edit-lock integration test

**File**: `src/db/matches.rls.test.ts` (new; **live-DB integration test**, NOT a
mocked unit test)

**Intent**: Pin the security boundary: non-admin match writes are denied, and an
`UPDATE` to a past-kickoff match is denied even for the admin.

**Contract**: Connects to the running local Supabase DB (different role JWTs:
anon / participant / admin) and asserts (a) a participant-role client's
`insert`/`update` on `matches` returns an RLS error / zero rows, and (b)
updating a row whose `kickoff_time < now()` returns zero rows (RLS `USING`
filters it out — see Phase 2 §5, F2). **A mocked Supabase client cannot test
RLS** — RLS is enforced by Postgres, not the client — so this test must hit a
real DB. Guard it so it self-skips when no DB is configured:
`describe.skipIf(!process.env.SUPABASE_DB_URL)` (or split it into a separate
`test:integration` script). It therefore does NOT run in the default `npm test`
/ CI gate (CI has no Supabase stack — `.github/workflows/ci.yml`); it runs
locally against `npx supabase start`.

### Success Criteria:

#### Automated Verification:

- Migration applies cleanly: `npm run db:reset`
- Types regenerate without diff drift after a second run: `npm run db:types`
- Type checking passes: `npm run build` (astro check) or `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Unit suite still green: `npm test` (the RLS integration test self-skips with no DB)

#### Manual / Integration Verification:

- RLS/edit-lock integration test passes against a local DB:
  `SUPABASE_DB_URL=... npm test` (or `npm run test:integration`) with
  `npx supabase start` running.
- In Supabase Studio, the admin can insert a match; a participant-role session cannot.
- An `UPDATE` on a past-kickoff match is rejected at the DB.

**Implementation Note**: After completing this phase and all automated
verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Server mutation layer

### Overview

Install the net-new deps, add the shared Zod schemas, the timezone-conversion and
bulk-parse utilities (with unit tests), the Astro Actions, and the middleware
admin-route gate.

### Changes Required:

#### 1. Dependencies

**File**: `package.json`

**Intent**: Add the form, resolver, timezone, and CSV-parse libraries the UI and
parser need.

**Contract**: `npm install react-hook-form @hookform/resolvers @date-fns/tz papaparse`
and `npm install -D @types/papaparse`. (`date-fns` arrives transitively via the
Calendar component in Phase 3.)

#### 2. Shared Zod schemas

**File**: `src/lib/schemas/tournament.ts`, `src/lib/schemas/match.ts`

**Intent**: One schema per entity, imported by both the Actions (server validation)
and the React forms (`zodResolver`), so client and server validate identically.

**Contract**:
- `tournamentSchema`: `{ name: non-empty string, timeZone: IANA string }`.
- `matchInputSchema`: `{ homeTeam: non-empty, awayTeam: non-empty, kickoffLocal:
  string, timeZone: IANA }` → transforms to a UTC `Date` via `localToUtc`. A
  `.refine()` does NOT block past kickoff (decision: allowed-with-warning);
  past-ness is computed separately for the warning flag.
- **Canonical kickoff format**: `kickoffLocal` is a wall-clock string in the
  tournament zone, format **`"YYYY-MM-DD HH:mm"`** (24h, minute precision, no
  seconds, no offset). Both entry paths converge on this one string so client and
  server validate identically: the one-by-one form formats its picker `Date` to
  it (Phase 3 §3), and `parseMatchPaste` normalizes each pasted row to it (Phase 2
  §4). The schema parses it into parts `{y, mo, d, h, mi}` and hands them to
  `localToUtc(parts, timeZone)`.
- Because the schema `.transform()`s the type (string → `Date`), the form's
  `useForm` must use the input/output split:
  `useForm<z.input<typeof matchInputSchema>, unknown, z.output<typeof matchInputSchema>>`
  (research Vendor docs) — otherwise field types won't line up.
- `matchUpdateSchema`: `matchInputSchema` extended with `id: uuid`.

#### 3. Timezone conversion util

**File**: `src/lib/time.ts`

**Intent**: Centralize wall-clock↔UTC conversion so no caller hand-rolls Date math.

**Contract**: `localToUtc(wallClock, ianaZone): Date` (build a `TZDate` in the zone,
return the UTC instant) and `utcToZone(utc, ianaZone): TZDate` for display.

**Contract** (snippet — the load-bearing conversion, non-obvious due to the workerd UTC gotcha):

```typescript
import { TZDate } from "@date-fns/tz";
// wallClock parsed to parts {y,mo,d,h,mi}; construct in the tournament zone:
const utc = new TZDate(y, mo - 1, d, h, mi, ianaZone); // underlying timestamp is correct UTC
return new Date(utc.getTime());
```

#### 4. Bulk-paste parser util

**File**: `src/lib/bulk-parse.ts`

**Intent**: Turn pasted text into structured rows for the preview, delegating
delimited-structure parsing to Papa Parse and domain validation to the Zod schema.

**Contract**: `parseMatchPaste(text, timeZone): ParsedRow[]` where each `ParsedRow`
carries the raw line, the parsed fields, a `status: "valid" | "error"`, an optional
error message, and an `isPast: boolean` flag. Uses `Papa.parse(text, { header: false,
skipEmptyLines: true })`, normalizes each row's kickoff field to the canonical
`"YYYY-MM-DD HH:mm"` `kickoffLocal` string (Phase 2 §2), then maps the row through
`matchInputSchema.safeParse`. A row whose kickoff can't be normalized to that
format flags `status: "error"` with a parse message.

#### 5. Astro Actions

**File**: `src/actions/index.ts`

**Intent**: Expose the type-safe, Zod-validated, admin-checked mutations the
islands call.

**Contract**: `export const server = { tournament: { upsert }, matches: { add,
bulkAdd, update } }`. Each handler: (1) builds the request Supabase client, (2)
throws `new ActionError({ code: "UNAUTHORIZED" })` unless
`context.locals.profile?.roles.includes("admin")`, (3) validates input against the
shared schema, (4) writes via the client (RLS is the backstop). `tournament.upsert`
implements the singleton create-or-edit. `matches.bulkAdd` inserts the validated
batch in one call. `matches.update` must chain `.update(...).select()` and treat
an **empty returned set as a lock failure** — the RLS `UPDATE USING
(kickoff_time > now())` policy filters a past-kickoff row out silently (zero rows,
no error), so the handler throws a friendly `ActionError` (e.g.
`{ code: "FORBIDDEN" }`, "this match has already kicked off") rather than
reporting success. The app-layer pre-check is only for an earlier/nicer message;
the zero-row check is the race-proof guard. Per-field errors surface via
`isInputError()` to the islands.

#### 6. Middleware admin-route gate

**File**: `src/middleware.ts`

**Intent**: Make admin pages redirect non-admins, extending the existing
default-deny gate with a role check.

**Contract**: Add an `ADMIN_ROUTES` prefix list (e.g. `/admin`); after the existing
auth check, if the path is an admin route and
`!context.locals.profile?.roles.includes("admin")`, redirect to `/dashboard`.
Extend `src/middleware.test.ts` (existing mock harness) with admin-gate cases:
a participant-only profile visiting `/admin` → 302 to `/dashboard`; an admin
profile → 200 (`next()` called); and a prefix-collision path (`/administrators`)
is gated, not let through. This is the one S-02 security door unit-testable in
CI today, so it runs in the default `npm test` gate.

#### 7. Util unit tests

**File**: `src/lib/time.test.ts`, `src/lib/bulk-parse.test.ts`

**Intent**: Pin the two highest-risk algorithmic pieces.

**Contract**: `time.test.ts` asserts a known wall-clock+zone maps to the expected
UTC ISO string (incl. a DST boundary case). `bulk-parse.test.ts` asserts valid
lines parse, malformed lines flag `error` with a message, blank lines skip, and
past-kickoff rows set `isPast`.

### Success Criteria:

#### Automated Verification:

- Deps install and lockfile updates: `npm install`
- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- TZ + parser unit tests pass: `npm test`
- Middleware admin-gate tests pass: `npm test`
- `check:wrangler` still green: `npm run check:wrangler`

#### Manual Verification:

- Calling an Action as a non-admin (e.g. via a participant session) returns `UNAUTHORIZED`.
- A wall-clock kickoff entered in a non-UTC zone round-trips to the right UTC instant.

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: One-by-one tournament + match UI

### Overview

Add the shadcn primitives and build the admin pages: create/edit the tournament,
add a match via a form with a date-time picker, and list existing matches with an
edit-before-kickoff affordance.

### Changes Required:

#### 1. shadcn primitives

**File**: `src/components/ui/{popover,calendar,form,input}.tsx` (generated)

**Intent**: Pull in the Date Picker building blocks and form wrappers.

**Contract**: `npx shadcn@latest add popover calendar form input`. Do not
hand-author these (AGENTS.md). `date-fns` + `react-day-picker` arrive via Calendar.
Note: the current "new-york" registry may emit the newer `Field`/`FieldGroup`/
`FieldLabel` API (`@/components/ui/field`, as in research §3) rather than
`Form`/`FormField`/`FormMessage`. After the `add`, confirm which family was
generated and use it consistently in the forms below — the `FormField` references
in §2–§3 assume the `form` family; adapt to `Field` if that's what landed.

#### 2. Tournament create/edit form

**File**: `src/components/admin/TournamentForm.tsx`

**Intent**: Single form that creates the tournament when none exists or edits it
when it does; captures name + IANA timezone (defaulting to the browser zone).

**Contract**: react-hook-form + `zodResolver(tournamentSchema)`; default `timeZone`
from `Intl.DateTimeFormat().resolvedOptions().timeZone`; submits via
`actions.tournament.upsert`. Renders per-field errors via shadcn `FormMessage`.

#### 3. Match (one-by-one) form

**File**: `src/components/admin/MatchForm.tsx`

**Intent**: Add a single match (home, away, kickoff date + time) in the tournament
timezone.

**Contract**: react-hook-form with the `z.input`/`z.output` `useForm` signature
(Phase 2 §2) + `zodResolver(matchInputSchema)`; date+time via the composed
Popover+Calendar+`<input type="time">` pattern bound through
`Controller`/`FormField` (research Vendor docs). On submit, format the picker
`Date` to the canonical `"YYYY-MM-DD HH:mm"` `kickoffLocal` string using
local-part getters (`getFullYear`/`getMonth`/… — no zone math; the picked
wall-clock is treated verbatim as tournament-zone wall-clock). The tournament
`timeZone` is passed in and submitted with the row; submits via
`actions.matches.add`.

#### 4. Admin page + match list

**File**: `src/pages/admin/index.astro` (or `tournament.astro`),
`src/components/admin/MatchList.tsx`

**Intent**: The admin landing surface that renders the tournament form, the
add-match form, and the list of matches with an edit control disabled for
already-kicked-off matches (showing a "locked" state).

**Contract**: Astro page reads the tournament + matches server-side (admin RLS),
renders the React islands via `client:load`; `MatchList` shows kickoff in the
tournament zone (`utcToZone`) and exposes edit (reusing `MatchForm` semantics via
`actions.matches.update`) only when `kickoff_time > now()`. Also add an admin-only
link to `/admin` from `src/pages/dashboard.astro` (rendered when
`locals.profile?.roles.includes("admin")`) so the admin actually "lands on" the
admin area from the post-signin dashboard rather than having to type the URL.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Production build succeeds: `npm run build`

#### Manual Verification:

- Admin creates the tournament; re-visiting shows the edit form (no second create).
- Admin adds a match; it appears in the list with the correct local kickoff.
- Editing a future match works; a past-kickoff match shows locked / no edit.
- A non-admin visiting `/admin` is redirected to `/dashboard`.

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Bulk-paste import

### Overview

Build the paste→preview→confirm island: parse the pasted list, show an
inline-editable preview with per-row validity and past-kickoff warnings, and save
the whole batch atomically.

### Changes Required:

#### 1. Bulk-paste import island

**File**: `src/components/admin/BulkPasteImport.tsx`

**Intent**: The largest admin-facing piece — a textarea that parses on input into
an editable preview table, lets the admin fix errored rows in place, and confirms.

**Contract**: On paste/change, call `parseMatchPaste(text, tournamentZone)` (Phase
2). Render rows in an editable table: each field editable; status badge
valid/error with the message; a visible warning on `isPast` rows. The Confirm
button is enabled only when zero rows are in `error` status (edits re-validate via
`matchInputSchema`). Confirm calls `actions.matches.bulkAdd` with the validated
batch; on success, refresh the list.

#### 2. Wire into the admin page

**File**: `src/pages/admin/index.astro`

**Intent**: Surface the bulk-paste island alongside the one-by-one form (the
one-by-one flow remains the graceful-degradation fallback per the roadmap).

**Contract**: Mount `BulkPasteImport` with the tournament `timeZone`, `client:load`.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npx tsc --noEmit`
- Linting passes: `npm run lint`
- Production build succeeds: `npm run build`
- Parser unit tests still pass: `npm test`

#### Manual Verification:

- Pasting a clean fixture list previews all rows valid; Confirm saves them all.
- A list with one malformed line flags that row; fixing it inline enables Confirm.
- Past-kickoff rows are visibly warned but still saveable.
- A delimiter-flexible paste (e.g. tabs, or `home - away | date`) parses correctly.

**Implementation Note**: Pause for manual confirmation; this completes the slice.

---

## Testing Strategy

### Unit Tests:

- `src/lib/time.test.ts`: wall-clock+IANA zone → expected UTC ISO, including a DST
  boundary case (the load-bearing conversion for S-03/S-04).
- `src/lib/bulk-parse.test.ts`: valid lines parse; malformed lines flag with a
  message; blank lines skip; past-kickoff rows set `isPast`; delimiter variants.

### Integration Tests:

- `src/db/matches.rls.test.ts`: non-admin match write denied; admin write allowed;
  past-kickoff `UPDATE` denied (FR-008 boundary).

### Manual Testing Steps:

1. As admin, create the tournament (name + zone); confirm re-visit shows edit.
2. Add a match via the form; verify the listed kickoff matches what was entered.
3. Bulk-paste a fixture list; introduce one bad line; fix inline; confirm batch.
4. Attempt to edit a past-kickoff match (expect locked); attempt a write as a
   participant (expect redirect / denial).

## Performance Considerations

Small scale (one tournament, ~48–64 matches, 5–20 users). No pagination or
caching needed. Bulk-paste is a single synchronous client parse + one batch
insert. `(tournament_id, kickoff_time)` index covers the list query.

## Migration Notes

Forward-only migration; no existing match data. `npm run db:reset` rebuilds local
from F-01 + this migration. Per AGENTS.md, dropping/renaming columns later (S-04
adds result columns) is a separate, approval-gated migration.

## References

- Research: `context/changes/tournament-and-matches/research.md`
- Roadmap S-02: `context/foundation/roadmap.md:94`
- F-01 RLS/helper patterns: `supabase/migrations/20260528232000_identity_boundary.sql`
- Existing mutation pattern: `src/pages/api/auth/signin.ts`
- Profile/role shape: `src/types.ts`, `src/middleware.ts:40`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Data layer

#### Automated

- [x] 1.1 Migration applies cleanly: `npm run db:reset`
- [x] 1.2 Types regenerate without diff drift: `npm run db:types` (hand-written types are an exact match for the generated output)
- [x] 1.3 Type checking passes: `npx tsc --noEmit`
- [x] 1.4 Linting passes: `npm run lint`
- [x] 1.5 Unit suite still green: `npm test` (RLS integration test self-skips with no DB)

#### Manual / Integration

- [x] 1.6 RLS/edit-lock integration test passes against a local DB (`SUPABASE_DB_URL=... npm test` with `npx supabase start`) — 5/5 pass
- [x] 1.7 Admin can insert a match in Studio; participant cannot (asserted by RLS test: admin insert succeeds, participant insert 403)
- [x] 1.8 `UPDATE` on a past-kickoff match is rejected at the DB (asserted by RLS test: past-kickoff update returns zero rows)

### Phase 2: Server mutation layer

#### Automated

- [x] 2.1 Deps install and lockfile updates: `npm install`
- [x] 2.2 Type checking passes: `npx tsc --noEmit`
- [x] 2.3 Linting passes: `npm run lint`
- [x] 2.4 TZ + parser unit tests pass: `npm test`
- [x] 2.5 Middleware admin-gate tests pass: `npm test`
- [x] 2.6 `check:wrangler` still green: `npm run check:wrangler`

#### Manual

- [x] 2.7 Calling an Action as a non-admin returns `UNAUTHORIZED` (401, "Admin access required" with valid input)
- [x] 2.8 Wall-clock kickoff in a non-UTC zone round-trips to the right UTC instant (Warsaw 20:00 → 18:00Z)

### Phase 3: One-by-one tournament + match UI

#### Automated

- [x] 3.1 Type checking passes: `npx tsc --noEmit`
- [x] 3.2 Linting passes: `npm run lint`
- [x] 3.3 Production build succeeds: `npm run build`

#### Manual

- [x] 3.4 Admin creates tournament; re-visit shows edit (no second create)
- [x] 3.5 Admin adds a match; correct local kickoff appears in the list
- [x] 3.6 Future match edits; past-kickoff match shows locked
- [x] 3.7 Non-admin visiting `/admin` is redirected to `/dashboard`

### Phase 4: Bulk-paste import

#### Automated

- [x] 4.1 Type checking passes: `npx tsc --noEmit`
- [x] 4.2 Linting passes: `npm run lint`
- [x] 4.3 Production build succeeds: `npm run build`
- [x] 4.4 Parser unit tests still pass: `npm test`

#### Manual

- [x] 4.5 Clean fixture list previews all valid; Confirm saves all
- [x] 4.6 Malformed line flagged; inline fix enables Confirm
- [x] 4.7 Past-kickoff rows warned but saveable
- [x] 4.8 Delimiter-flexible paste parses correctly (supported: `,` / tab / `;` / `|`; spaces intentionally unsupported — kickoff field contains a space)
