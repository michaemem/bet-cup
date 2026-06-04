# Tournament & Matches (S-02) — Plan Brief

> Full plan: `context/changes/tournament-and-matches/plan.md`
> Research: `context/changes/tournament-and-matches/research.md`

## What & Why

Give the single admin the tools to set up the tournament: create it (name +
timezone), populate its match list one-by-one or by bulk paste with a
parsed-preview-then-confirm flow, and edit matches before kickoff (FR-006/007/008/022).
This is the prerequisite for everything downstream — there are no predictions
(S-03) and no scoring (S-04) without matches, and the kickoff times entered here
drive both.

## Starting Point

F-01 is fully landed: `profiles` + `user_roles` + RLS + `is_admin()` helper +
`handle_new_user` trigger, a default-deny middleware that loads
`locals.profile.roles`, DB tooling (`db:migration:new`/`db:types`/`db:reset`),
generated `database.types.ts`, and a Vitest + happy-dom harness. The only existing
mutation pattern is plain API routes (`api/auth/signin.ts`); there is no
`src/actions/` dir, no admin-only route, and no application tables beyond identity.

## Desired End State

The admin lands on an `/admin` area, creates the one tournament, adds matches via
a date-time-picker form or a bulk-paste import with an inline-editable preview,
and edits any match while its kickoff is in the future. Kickoffs store as
UTC-correct `timestamptz`. Every surface is admin-only (redirect + RLS); editing a
kicked-off match is refused at both the app and DB layers.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
|---|---|---|---|
| Server mutation layer | Astro Actions (`src/actions/index.ts`) | Type-safe island calls + first-class Zod per-field errors; admin checked in-handler since Actions are public endpoints | Research + Plan |
| Edit-before-kickoff (FR-008) | RLS `UPDATE USING (kickoff_time > now())` **+** app pre-check | DB-enforced source of truth (can't be bypassed) plus a friendly message | Plan |
| Timezone capture | Single tournament-level IANA zone, set at creation | One decision per tournament not per match; matches the one-tournament domain | Plan |
| Kickoff storage/convert | `timestamptz` (UTC) via `@date-fns/tz` `TZDate` | workerd Date is always UTC; explicit conversion avoids drift into S-03/S-04 | Research |
| Single-tournament enforcement | App-level (create-or-edit), no DB constraint | Simplest schema, trivially relaxed post-MVP; it's a Non-Goal anyway | Plan |
| Bulk-paste parser | Papa Parse → per-row Zod | Delimiter-flexible, tolerant of messy pastes / names; sync string parse fits preview | Research + Plan |
| Bulk preview UX | Inline-editable rows, atomic batch save | Smoothest correction loop; one consistent save | Plan |
| Past-kickoff on add | Allowed, but flagged/warned in preview | Supports late setup / backfill without silently eating date typos | Plan |
| Match read access | Admin-only RLS this slice | Fixtures aren't sensitive, but participant read belongs to S-03's surface | Plan |
| Test surface | Parser + TZ unit tests + RLS/edit-lock integration | Pins the two algorithmic risks and the security boundary; scoring is S-04 | Plan |

## Scope

**In scope:**
- `tournaments` + `matches` tables, admin-only RLS, `kickoff_time > now()` edit-lock, regen types.
- `@date-fns/tz` wall-clock↔UTC util; Papa Parse → Zod bulk parser; shared Zod schemas.
- Astro Actions: `tournament.upsert`, `matches.add`, `matches.bulkAdd`, `matches.update`.
- Middleware admin-route gate; `/admin` page; tournament form; match form w/ date-time picker; match list w/ edit-before-kickoff.
- Inline-editable bulk-paste import island.
- Unit tests (parser, TZ) + RLS/edit-lock integration test.

**Out of scope:**
- Results, scoring, leaderboard (S-04) — no score columns here.
- Predictions, blindness RLS, participant match list (S-03).
- Multiple tournaments; DB singleton constraint; per-match timezone; natural-language dates.

## Architecture / Approach

Bottom-up: **DB** (tables + RLS + types) → **server** (Actions + shared schemas +
TZ util + parser util) → **one-by-one UI** (shadcn date picker + react-hook-form
islands) → **bulk-paste UI** (reuses the same Action + schemas). Defense-in-depth
runs throughout: admin checked in every Action handler *and* enforced by RLS; the
kickoff edit-lock enforced in both the Action and the DB policy.

## Phases at a Glance

| Phase | What it delivers | Key risk |
|---|---|---|
| 1. Data layer | `tournaments` + `matches`, admin RLS, edit-lock, regen types, RLS test | RLS `USING (kickoff_time > now())` correctness; clean type regen |
| 2. Server layer | Deps, shared Zod schemas, TZ + parser utils (+unit tests), Actions, middleware admin gate | workerd-UTC timezone conversion bug if `TZDate` is bypassed |
| 3. One-by-one UI | shadcn primitives, tournament + match forms, admin page, match list | Controlled date picker wiring via `Controller`/`FormField` |
| 4. Bulk-paste import | Editable-preview island, atomic batch save, past-kickoff warning | Largest UI piece; re-validation on inline edit before enabling Confirm |

**Prerequisites:** F-01 (`identity-boundary`) — landed. No other blockers.
**Estimated effort:** ~3–4 focused sessions; Phase 4 (editable preview) is the heaviest.

## Open Risks & Assumptions

- Astro Actions introduce a second mutation pattern alongside auth API routes — worth an AGENTS.md note on when to use which.
- `@date-fns/tz` `getTimezoneOffset()` has an inverted sign; use `tzOffset()` if an offset value is ever needed.
- App-level singleton means `tournament.upsert` is the only writer that must respect "one tournament" — no DB guardrail behind it.
- RLS integration testing against a local DB must fit the existing Vitest harness; the mock vs local-DB approach for `matches.rls.test.ts` may need a small harness decision.

## Success Criteria (Summary)

- Admin creates the tournament and adds matches (both flows); kickoffs round-trip to the correct UTC instant and display in the tournament zone.
- A non-admin cannot reach `/admin` or write matches (redirect + RLS); editing a kicked-off match is refused at both layers.
- `npm test` green (parser + TZ + RLS); `npm run build` ships a clean Worker.
