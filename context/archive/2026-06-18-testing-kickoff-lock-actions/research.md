---
date: 2026-06-18T19:32:30+0200
researcher: Cursor (Claude Opus 4.8)
git_commit: 762b6251c350fb1ee62bd110bb016fb0c4b89075
branch: testing-kickoff-lock-actions
repository: braveai-prj
topic: "Test-plan Phase 3 — kickoff-lock & action-layer mutations (Risks #4, #3)"
tags: [research, codebase, actions, predictions, rls, kickoff-lock, idor, testing]
status: complete
last_updated: 2026-06-18
last_updated_by: Cursor (Claude Opus 4.8)
---

# Research: Test-plan Phase 3 — kickoff-lock & action-layer mutations (Risks #4, #3)

**Date**: 2026-06-18T19:32:30+0200
**Researcher**: Cursor (Claude Opus 4.8)
**Git Commit**: 762b6251c350fb1ee62bd110bb016fb0c4b89075
**Branch**: testing-kickoff-lock-actions
**Repository**: braveai-prj

## Research Question

Ground rollout Phase 3 of `context/foundation/test-plan.md` ("Kickoff-lock &
action mutations") against the live code before planning:

- **Risk #4** — a prediction is created/edited after its match's kickoff
  (kickoff-lock bypass); the cutoff must use the server clock, not the client's.
- **Risk #3** — one participant creates/edits/deletes another participant's
  prediction (IDOR / ownership); the owner must be the session identity, never a
  client-supplied id.

Verify (don't blindly accept) the test-plan §2 response guidance, locate the
cheapest useful test layer, identify what is already covered vs the genuine
Phase 3 gap, and flag speculative risks or misleading evidence.

## Summary

**The Phase 3 gap is the action layer, and it is thin.** Both Risk #4 and Risk
#3 are already enforced _and tested at the DB/RLS layer_ by Phase 2's
`src/db/predictions.rls.test.ts` (spoofed-owner INSERT, cross-owner UPDATE/DELETE,
post-kickoff INSERT/UPDATE rejection, near-boundary crossing). What is **not**
covered is the Astro Action `predictions.upsert` (`src/actions/index.ts:503-543`),
for which **no `src/actions/predictions.test.ts` exists**.

Two corrections to the test-plan §2 Risk Response Guidance surfaced (see
"Test-plan §2 corrections" below — these are the post-research backport
candidates):

1. **Risk #3 at the action layer cannot test "rejects a spoofed owner id."**
   `predictionUpsertSchema` (`src/lib/schemas/prediction.ts:14-18`) has **no owner
   field** — only `matchId`, `homeGoals`, `awayGoals`. The handler sets
   `predictor_id: user.id` from the session unconditionally
   (`src/actions/index.ts:528`). There is no channel through the action to address
   another participant's row, so the action-layer assertion is "ownership is
   structurally derived from the session; the upsert is scoped to the caller's own
   row" — **not** "a spoofed owner id is rejected" (that is the DB-layer test,
   already shipped at `predictions.rls.test.ts:251-259`).

2. **Risk #4 "server clock" is two clocks, and the action's own pre-check clock
   is not the authoritative one.** The action's app-layer pre-check uses Node
   `Date.now()` (`src/actions/index.ts:520`) for a _friendly early message_; the
   race-proof, authoritative lock is the Postgres `now()` inside
   `match_is_kicked_off()` enforced by RLS (`...predictions_with_blindness.sql:69`,
   `:86`, `:91-92`), surfaced to the handler as a zero-row result →
   `FORBIDDEN`/`PREDICTION_LOCKED` (`src/actions/index.ts:540`). Neither clock is
   the _client's_. The cheapest action-layer test should assert the handler's
   translation of both the pre-check (NOT_FOUND vs PREDICTION_LOCKED) and the
   RLS zero-row guard, not re-prove the DB lock.

**Cheapest useful layer for Phase 3:** a new `src/actions/predictions.test.ts`
following the existing two-lane action-test harness
(`src/actions/participants.test.ts`, `account.test.ts`) — an always-runs lane
(unauthenticated → `UNAUTHORIZED` before any DB) plus a `describe.skipIf(!dbConfigured)`
live-DB lane that reuses the established cookie-jar session-context pattern. The
file must stay on the global `happy-dom` env (no `@vitest-environment node`) to
avoid the known supabase-js WebSocket failure (§ Open Questions / test-plan §6.6).

## Detailed Findings

### Action layer — `predictions.upsert` (`src/actions/index.ts:493-543`)

- Builds a **session** client (anon key + caller cookies), not service-role, so
  RLS owns both blindness and the kickoff lock (`index.ts:493-502`, `sessionClient`
  at `index.ts:95-105`). A privilege-bypassing client would silently defeat both —
  documented intent.
- Owner is derived: `predictor_id: user.id` (`index.ts:528`), with
  `onConflict: "predictor_id,match_id"` (`index.ts:533`). The caller can only ever
  upsert _their own_ (predictor, match) row.
- Kickoff lock is defense-in-depth:
  - app-layer pre-check reads `kickoff_time` and compares to `Date.now()`
    (`index.ts:511-522`); distinguishes `NOT_FOUND` (no such match,
    `index.ts:517-519`) from `FORBIDDEN`/`PREDICTION_LOCKED` (past kickoff,
    `index.ts:520-522`).
  - RLS zero-row guard is the race-proof source of truth: a post-kickoff write
    filters to zero rows with no error → handler throws `FORBIDDEN`
    (`index.ts:538-540`).
- Unauthenticated callers throw `UNAUTHORIZED` before any DB call
  (`sessionClient`, `index.ts:96-98`) — the always-runs lane.

Sibling kickoff-guarded handlers for context (Phase 3 §3 row also mentions admin
result entry + correction recompute):

- `matches.update` — admin-only edit, refused post-kickoff via app pre-check
  (`index.ts:468-473`) + RLS zero-row (`index.ts:486-488`).
- `results.upsert` — admin-only, mirror guard: a result may only be written
  _after_ kickoff (`index.ts:576-578` app pre-check; `index.ts:593-595` RLS
  zero-row). Correction is an upsert on unique `match_id`, so scoring/leaderboard
  recompute on next read (`index.ts:545-556`).

### DB enforcement (already in place, already tested)

- `match_is_kicked_off(p_match_id)` — `language sql stable security definer`,
  predicate `kickoff_time <= now()` (server clock)
  (`supabase/migrations/20260604184657_predictions_with_blindness.sql:60-71`).
- `predictions` RLS (`...predictions_with_blindness.sql:76-92`):
  - SELECT: `predictor_id = auth.uid() or match_is_kicked_off(match_id)` (blindness).
  - INSERT: `with check (predictor_id = auth.uid() and not match_is_kicked_off(match_id))`.
  - UPDATE: `using/with check (predictor_id = auth.uid() and not match_is_kicked_off(match_id))`.
  - **No DELETE policy** (default-deny) — predictions are not user-deletable in S-03.
- `match_results` RLS: INSERT/UPDATE require `is_admin() and match_is_kicked_off(match_id)`
  (`supabase/migrations/20260605052647_results_scoring_leaderboard.sql:61-70`).
- `matches` UPDATE RLS: `using (is_admin() and kickoff_time > now())`
  (`supabase/migrations/20260602180000_tournament_and_matches.sql:103-107`).
- `is_admin()` — `stable security definer`, checks `user_roles` for `auth.uid()`
  - `role = 'admin'` (`supabase/migrations/20260528232000_identity_boundary.sql:88-93`).

### Coverage map — already covered vs Phase 3 gap

| Invariant                                | DB enforcement                               | DB test (exists)                                     | Action test (Phase 3 target)                          |
| ---------------------------------------- | -------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| Kickoff lock #4 (post-kickoff INSERT)    | predictions INSERT `not match_is_kicked_off` | `predictions.rls.test.ts:203-211`                    | **gap** — no `predictions.test.ts`                    |
| Kickoff lock #4 (post-kickoff UPDATE)    | predictions UPDATE USING                     | `predictions.rls.test.ts:213-224`                    | **gap**                                               |
| Kickoff lock #4 (near-boundary)          | Postgres `now()` per row                     | `predictions.rls.test.ts:328-372` (SELECT flip only) | **gap** (and DB write-at-boundary not covered either) |
| Ownership #3 (spoofed INSERT)            | INSERT `predictor_id = auth.uid()`           | `predictions.rls.test.ts:251-259`                    | **N/A at action** — no owner channel in schema        |
| Ownership #3 (cross-owner UPDATE/DELETE) | UPDATE USING / no DELETE policy              | `predictions.rls.test.ts:261-303`                    | **gap** — assert action upsert is caller-scoped       |
| Unauthenticated write                    | session required                             | —                                                    | **gap** — always-runs `UNAUTHORIZED` lane             |
| Admin result entry / correction          | `match_results` RLS                          | `results-scoring.rls.test.ts:377-414`                | `results.test.ts` admin-guard only (`:46-60`)         |

### Test harness blueprint (from existing action tests)

- Single Vitest config: global `happy-dom` env; aliases `astro:actions`,
  `astro:env/server`, `astro:middleware` to `test/stubs/*`, and `@/*` → `src/*`
  (`vitest.config.ts:9-25`). No `setupFiles`, no dotenv.
- `astro:actions` stub: `defineAction` is identity, `ActionError` is a real
  throwable with `.code` (`test/stubs/astro-actions.ts:6-17`). Handlers are reached
  via `const { server } = await import("@/actions/index")` then
  `(server.x.y as unknown as { handler }).handler` (`results.test.ts:18,32`).
- `astro:env/server` stub reads `process.env.SUPABASE_ANON_KEY` for `SUPABASE_KEY`
  (`test/stubs/astro-env-server.ts:5-7`).
- **No shared test helper module** — each file inlines `cookieStub()`, env
  constants, `dbConfigured`, and context builders. Copy from
  `account.test.ts:68-152` (session/participant) or `participants.test.ts:264-288`
  (admin SSR).
- Two lanes: always-run guard tests (throw before DB) + `describe.skipIf(!dbConfigured)`
  live-DB (`dbConfigured = Boolean(SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY)`,
  `participants.test.ts:44`).
- happy-dom strips the `Cookie` header on `new Request(...)`; live-DB tests build a
  plain `{ headers: { get } }` stub returning the serialized cookie jar
  (`account.test.ts:140-143`).
- Run: `npm test` (live lanes self-skip); live-DB locally needs `npx supabase start`
  - the four `SUPABASE_*` env vars; CI `rls` job runs `npm test -- rls`
    (`.github/workflows/ci.yml`).

### Reusable live-DB fixtures (Phase 2, `predictions.rls.test.ts`)

`beforeAll` (`predictions.rls.test.ts:73-126`) seeds: service/admin/participantA/
participantB clients, a tournament, `futureMatchId` + `pastMatchId(2)`, A's
future-match prediction (via participant session) and a past-match prediction
(via service-role, bypassing the post-kickoff INSERT lock). `seedMatch` runs on the
admin session (`:134-143`); teardown cascades the tournament + deletes auth users
(`:128-132`). These are _in `src/db/`_, not importable — the Phase 3 action file will
inline equivalent setup (admin-created participants A/B, a future and a soon/past
match), reusing the idioms not the code.

## Code References

- `src/actions/index.ts:493-543` — `predictions.upsert` handler (session client,
  owner-from-session, dual kickoff guard).
- `src/actions/index.ts:520` — app-layer pre-check `Date.now()` (friendly message).
- `src/actions/index.ts:528,533` — `predictor_id: user.id`, `onConflict`.
- `src/actions/index.ts:538-540` — RLS zero-row → `FORBIDDEN` (authoritative lock).
- `src/actions/index.ts:95-105` — `sessionClient` (UNAUTHORIZED if no session user).
- `src/lib/schemas/prediction.ts:14-18` — `predictionUpsertSchema` (no owner field).
- `supabase/migrations/20260604184657_predictions_with_blindness.sql:60-92` —
  `match_is_kicked_off` + predictions RLS policies.
- `src/db/predictions.rls.test.ts:203-372` — existing DB coverage for #4 and #3.
- `src/actions/results.test.ts:18-60` — canonical always-runs action-guard test.
- `src/actions/account.test.ts:68-152` — session/participant live-DB context builder.
- `src/actions/participants.test.ts:264-288` — admin SSR live-DB context builder.
- `vitest.config.ts:9-25`, `test/stubs/astro-actions.ts:6-17` — harness wiring.

## Test-plan §2 corrections (post-research backport candidates)

These adjust the Source/response cells only — no file anchors added to §2.

1. **Risk #3 response guidance** — current text: _"the server rejects a spoofed
   owner id and trusts only the session identity."_ At the **action layer** there
   is no owner input to spoof (`predictionUpsertSchema` has no such field;
   `predictor_id` is derived from the session). Reframe the action-layer
   expectation to _"the action exposes no owner channel; `predictor_id` is the
   session identity and the upsert is scoped to the caller's own row."_ The
   "rejects a spoofed owner id" expectation remains valid but belongs to the DB
   layer (already covered, `predictions.rls.test.ts:251-259`).

2. **Risk #4 response guidance** — current text: _"the cutoff uses the server
   clock, not the client's."_ Accurate but ambiguous: the action's _own_ pre-check
   uses Node `Date.now()` (advisory, friendly message); the authoritative lock is
   Postgres `now()` via RLS, surfaced as a zero-row → `FORBIDDEN`. The action test
   should assert the **handler's translation** (NOT_FOUND vs PREDICTION_LOCKED, and
   zero-row → FORBIDDEN), not re-prove the DB clock (that is the RLS test).

3. **Scope note for §3 Phase 3** — much of #3/#4 is already pinned at the DB layer
   by Phase 2. The genuine, non-duplicative action-layer value is: (a) the
   always-runs `UNAUTHORIZED` lane, (b) the app-layer pre-check messages and
   NOT_FOUND/FORBIDDEN discrimination, (c) caller-scoping of the upsert. Planning
   should avoid re-asserting RLS behavior already green in `predictions.rls.test.ts`.

## Phase 1 implementation finding (for Phase 2 §6.6 + lessons.md backport)

**The predictions kickoff backstop surfaces as `INTERNAL_SERVER_ERROR`, not the
`FORBIDDEN`/zero-row the plan/research assumed.** Empirically verified during
Phase 1's manual step 1.5 (pre-check temporarily commented out, live stack):

- `predictions.upsert` issues `INSERT … ON CONFLICT DO UPDATE` (supabase-js
  `.upsert({ onConflict })`). Postgres evaluates the **INSERT policy's
  `WITH CHECK (… not match_is_kicked_off …)`** on the proposed row first, and for a
  post-kickoff row raises a hard error (`42501`) — **for both the create AND the
  edit path** (the ON CONFLICT DO UPDATE never gets to run a zero-row filter,
  because the INSERT WITH CHECK fails first).
- The handler maps any DB `error` through `internalError()` → generic
  `INTERNAL_SERVER_ERROR` (secret-safe). So with the pre-check removed, the
  post-kickoff cases reject as `INTERNAL_SERVER_ERROR`, not `FORBIDDEN`.
- Consequence: the handler's `if (data.length === 0) throw … FORBIDDEN` zero-row
  branch (`src/actions/index.ts:540`) is **effectively dead for the predictions
  upsert** — it's the `matches.update` plain-`UPDATE` path that yields zero rows,
  not this upsert path. The race-proof property still holds (the DB blocks the
  write independent of the pre-check); only the surfaced code differs.
- **Backport actions for Phase 2**: (a) correct §6.6 / the action-test convention
  note to say "the race-proof predictions lock is a `WITH CHECK` rejection
  (surfaced generic), and `FORBIDDEN` on the happy path comes from the app
  pre-check"; (b) candidate `lessons.md` entry: _"`upsert({ onConflict })` is an
  `INSERT ON CONFLICT` — the INSERT `WITH CHECK` fires before conflict resolution,
  so a policy-violating upsert raises `42501` (mapped to `INTERNAL_SERVER_ERROR`),
  it does NOT fall through to a zero-row result. Reserve the `data.length === 0 →
FORBIDDEN` pattern for plain `.update()` paths (e.g. `matches.update`)."_
- Not a code/test defect: with the pre-check in place every post-kickoff case
  correctly returns `FORBIDDEN` and the Phase 1 tests are green.

## Architecture Insights

- **Defense-in-depth is the house style**: every mutating handler pairs an
  app-layer pre-check (friendly, early, non-authoritative) with the RLS zero-row
  guard (race-proof, authoritative). Tests should target the _translation_ the
  handler adds, and leave the raw policy to the RLS suite.
- **Owner identity is never client-trusted** — it is read from `locals.user`/
  `auth.uid()`. IDOR resistance at the action layer is _structural_ (no input
  field), which is a stronger statement than "rejected if spoofed."
- **Two-lane test discipline** keeps the default CI gate DB-free; live-DB lanes
  self-skip and only run in the dedicated `rls` job or locally with the stack up.

## Historical Context (from prior changes)

- `context/changes/testing-scoring/plan.md:45-51` — Phase 1 explicitly deferred
  action-layer mutation tests to Phase 3; landed DB-level scoring + a unit schema
  test.
- `context/archive/2026-06-05-testing-blindness-ownership/plan.md` — Phase 2 added
  the 6 live-DB RLS cases + static service-role isolation guard now in
  `predictions.rls.test.ts:249-435`; documented the shared `beforeAll` fixtures.
- `context/foundation/lessons.md:12-17` — secret-isolation criteria must target
  production reads / importer counts, not raw `rg` across `src/` (relevant if
  Phase 3 adds any static guard).

## Related Research

- `context/changes/testing-scoring/research.md` — Phase 1 DB-level scoring research.
- `context/archive/2026-06-05-testing-blindness-ownership/research.md` — Phase 2
  blindness/ownership research (origin of the shared fixtures).

## Open Questions

- **supabase-js WebSocket under node env** (test-plan §6.6,
  `test-plan.md:223-232`): `results-scoring.rls.test.ts` (`@vitest-environment node`)
  fails at client init on supabase-js 2.105.3. **Mitigation for Phase 3:** keep
  `predictions.test.ts` on the global `happy-dom` env (which provides `WebSocket`) —
  the existing action tests and `predictions.rls.test.ts` already do. Do **not**
  add a node pragma. The WebSocket fix itself remains a separate change, out of
  scope here.
- **Should Phase 3 also extend `results.test.ts`** (admin result entry +
  correction recompute, named in the §3 Phase 3 row) or leave the post-kickoff
  result path to `results-scoring.rls.test.ts:377-414`? This is a planning
  decision: the action layer adds the admin-guard + NOT/POST-kickoff message
  discrimination; the recompute itself is a DB concern already covered. Flag for
  `/10x-plan`.
- **Node version**: the live-DB lanes require the repo-pinned Node 22 (supabase-js
  native WebSocket); Node 20 fails (`testing-scoring/reviews/impl-review.md:51`).
