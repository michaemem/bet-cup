# Kickoff-lock & action-layer mutation tests (test-plan Phase 3) — Implementation Plan

## Overview

Add the missing **action-layer** integration tests for `predictions.upsert` —
the kickoff write-lock (Risk #4) and ownership (Risk #3) surface that the DB/RLS
layer already enforces but the Astro Action layer does not yet test — and close
the one DB-layer gap where the kickoff *boundary* is only proven for SELECT
blindness, not for a write. Follows the established two-lane action-test harness
(`src/actions/participants.test.ts`, `account.test.ts`) and stays on the global
`happy-dom` env.

## Current State Analysis

- **No `src/actions/predictions.test.ts` exists.** `predictions.upsert`
  (`src/actions/index.ts:503-543`) is the only untested mutating action on the
  predictions surface.
- The handler runs on a **session client** (anon key + caller cookies), derives
  `predictor_id: user.id` from the session (`index.ts:528`), and guards kickoff
  twice: an app-layer pre-check using Node `Date.now()` for a friendly message
  (`index.ts:511-522`, distinguishing `NOT_FOUND` from `PREDICTION_LOCKED`) plus
  the race-proof RLS zero-row guard (`index.ts:538-540`).
- **Ownership at the action layer is structural**: `predictionUpsertSchema`
  (`src/lib/schemas/prediction.ts:14-18`) has no owner field — there is no channel
  to address another participant's row. The spoof-rejection test belongs to the DB
  layer and is already shipped (`src/db/predictions.rls.test.ts:251-259`).
- **DB layer is otherwise complete** for #3/#4: post-kickoff INSERT/UPDATE
  rejection (`predictions.rls.test.ts:203-224`), cross-owner UPDATE/DELETE
  (`:261-303`). The near-boundary test (`:328-372`) polls until Postgres `now()`
  crosses kickoff but asserts **only the SELECT blindness flip** — it does not
  assert that a *write* is rejected once the boundary is crossed.
- **Harness**: single `vitest.config.ts` (global `happy-dom`, `:9-25`); `astro:*`
  virtual modules aliased to `test/stubs/*` (`defineAction` is identity →
  `.handler` reachable). No shared test helper module — each file inlines
  `cookieStub()`, env constants, `dbConfigured`, and context builders. Two lanes:
  always-run guards (throw before DB) + `describe.skipIf(!dbConfigured)` live-DB.
- **Known gotcha**: supabase-js 2.105.3 throws on client init under
  `@vitest-environment node` (WebSocket). `predictions.test.ts` MUST stay on
  `happy-dom` (the default) — do not add a node pragma (test-plan §6.6).

## Desired End State

- A new `src/actions/predictions.test.ts` with: an always-runs `UNAUTHORIZED`
  lane (runs in default `npm test` / CI gate, no Supabase), and a
  `describe.skipIf(!dbConfigured)` live-DB lane covering the core case set.
- `src/db/predictions.rls.test.ts` gains one near-boundary **write**-flip case.
- `npm test` stays green with no DB (live lanes self-skip); `npm test -- predictions`
  passes against the local Supabase stack.
- `test-plan.md` §6.3 (action-layer cookbook) and §6.6 (Phase 3 notes) filled in;
  §3 Phase 3 → `complete`.

### Key Discoveries:

- `src/actions/index.ts:503-543` — `predictions.upsert`: session client,
  owner-from-session, dual kickoff guard, NOT_FOUND vs PREDICTION_LOCKED vs
  zero-row→FORBIDDEN translation.
- `src/lib/schemas/prediction.ts:14-18` — no owner field (ownership is structural).
- `src/actions/account.test.ts:68-152` — the session/participant live-DB context
  builder (`cookieStub`, `authedContext` via `@supabase/ssr` cookie jar, plain
  `{ headers: { get } }` stub because happy-dom strips `Cookie`).
- `src/actions/results.test.ts:18-60` — canonical always-runs guard test (handler
  reached via `(server.x.y as unknown as { handler }).handler`, input via schema
  `.parse(...)`).
- `src/db/predictions.rls.test.ts:328-372` — existing near-boundary SELECT-flip
  case to mirror for the write-flip; `:62-143` shared `beforeAll` fixtures +
  `seedMatch`.
- `test-plan.md` §6.6 (`:223-232`) — supabase-js node-env WebSocket issue; keep
  happy-dom.

## What We're NOT Doing

- **No changes to `results.test.ts`** — admin result entry / correction recompute
  is already covered by `src/db/results-scoring.rls.test.ts:377-414`; re-asserting
  it at the action layer adds no signal (cost × signal).
- **Not re-proving RLS spoof-rejection / cross-owner mutation at the action layer**
  — there is no owner channel in the action input; that behavior lives in
  `predictions.rls.test.ts` and is already green.
- **Not fixing the supabase-js node-env WebSocket bug** — separate change; we work
  around it by staying on happy-dom.
- **No new shared test-helper module** — house style inlines fixtures per file.
- **Not promoting any new CI gate** — that is §3 Phase 4. The new action tests ride
  the existing default `ci` job (always-runs lane) and `rls` job conventions.

## Implementation Approach

Mirror the existing two-lane action-test pattern. Phase 1 adds the action-layer
file (the true Phase 3 gap, and the always-runs lane lands value in the default CI
gate immediately). Phase 2 closes the DB boundary gap with a single write-flip
case and documents both in the test-plan cookbook. Assertions check the error
**code + which branch fired** (NOT_FOUND vs FORBIDDEN), never exact message
strings (messages are UX, not contract) and never Postgres `error.code`.

## Phase 1: Action-layer `predictions.upsert` tests

### Overview

New `src/actions/predictions.test.ts` exercising the real `predictions.upsert`
handler: an always-runs unauthorized guard plus a live-DB core set proving the
kickoff lock, the NOT_FOUND/locked discrimination, and caller-scoping.

### Changes Required:

#### 1. New action test file

**File**: `src/actions/predictions.test.ts`

**Intent**: Pin the action-layer behavior of `predictions.upsert` that sits on top
of RLS — the friendly-message discrimination, the zero-row→FORBIDDEN translation,
and that a participant can only ever write their own row. Two lanes so the
unauthorized guard runs in the default DB-free CI gate.

**Contract**:
- File header docblock mirroring `results.test.ts:1-11` (FR refs FR-011–FR-014,
  two-lane strategy, local live-DB run env). **No `@vitest-environment` pragma**
  (stay on global happy-dom).
- Reach the handler via `const { server } = await import("@/actions/index")` then
  `(server.predictions.upsert as unknown as { handler: … }).handler`; validate
  input with `predictionUpsertSchema.parse(...)` before calling (mirror
  `results.test.ts:18,32,38`).
- **Always-runs lane** — `describe("predictions.upsert (always runs)")`: calling
  the handler with `locals.user` absent rejects with code `UNAUTHORIZED` before any
  DB call (the `sessionClient` guard, `index.ts:96-98`).
- **Live-DB lane** — `describe.skipIf(!dbConfigured)(…)` with `dbConfigured =
  Boolean(process.env.SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY)`. Inline
  `cookieStub()` and an `authedContext(email,password)` builder copied from
  `account.test.ts:68-152` (cookie-jar sign-in via `@supabase/ssr`
  `createServerClient`; plain `{ headers: { get } }` stub so happy-dom doesn't strip
  `Cookie`). `beforeAll` seeds (service-role): participants A and B (admin-created
  users), a tournament, a **future** match and a **past** match (mirror
  `predictions.rls.test.ts:73-143` idioms; past prediction seeded via service-role
  to bypass the INSERT lock). `afterAll` cascades the tournament + deletes the auth
  users.
- **Core cases** (assert error **code + branch**, not message text):
  1. pre-kickoff create on the future match → returns a row; the row's
     `predictor_id` equals A's id (caller-scoped).
  2. pre-kickoff edit (second upsert, same match) → succeeds, updates in place
     (unique `predictor_id,match_id`).
  3. post-kickoff create on the past match → throws `FORBIDDEN` (the
     `PREDICTION_LOCKED` branch / zero-row guard).
  4. post-kickoff edit on the past match → throws `FORBIDDEN`.
  5. bad/unknown `matchId` (well-formed uuid, no such match) → throws `NOT_FOUND`
     (distinct from the lock branch).
  6. caller-scoping (#3): acting as B, upsert on the future match writes B's own
     row; A's pre-existing row for that match is unchanged (assert A still has its
     own row with A's values). Confirms the action exposes no path to B mutating A.

### Success Criteria:

#### Automated Verification:

- Type checking passes: `npm run lint`
- Default suite green with no DB (always-runs lane runs, live lane skips): `npm test`
- Live-DB lane passes against the local stack: `npx supabase start` then
  `SUPABASE_DB_URL=… SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… npm test -- predictions`
  (under repo-pinned Node 22)

#### Manual Verification:

- The always-runs `UNAUTHORIZED` test is visibly executed (not skipped) in a plain
  `npm test` run with no Supabase env.
- Each post-kickoff case fails for the right reason: temporarily relax/skip the app
  pre-check assertion locally and confirm the RLS zero-row guard still yields
  FORBIDDEN (the lock is race-proof, not just the pre-check).

---

## Phase 2: DB boundary write-flip + cookbook

### Overview

Close the single DB-layer gap (boundary proven only for SELECT) with one
near-boundary write case, then document the action-layer pattern and Phase 3
outcome in the test-plan.

### Changes Required:

#### 1. Near-boundary write-flip case

**File**: `src/db/predictions.rls.test.ts`

**Intent**: Prove the kickoff write-lock flips at the *exact* boundary — a create
that succeeds pre-kickoff is rejected once Postgres `now()` crosses kickoff —
complementing the existing SELECT-flip case.

**Contract**: New `it(…, 20000)` inside the existing live-DB describe, mirroring the
near-boundary idiom at `:328-372`: `seedMatch` a match ~3s out, participant A
inserts a prediction pre-kickoff (succeeds), then **poll** the participant client
(never a fixed sleep) until a fresh INSERT/UPDATE on that match is rejected
post-kickoff (`error` non-null for INSERT WITH CHECK, or zero rows for UPDATE).
Assert the pre-kickoff write succeeded and the post-boundary write is locked. Do
not assert Postgres `error.code`.

#### 2. Cookbook + Phase 3 notes

**File**: `context/foundation/test-plan.md`

**Intent**: Fill the §6.3 action-layer cookbook (currently TBD) with the
`predictions.test.ts` pattern, add a §6.6 Phase 3 entry, and mark §3 Phase 3
`complete`.

**Contract**:
- §6.3: replace the TBD with the two-lane action-test recipe (handler-via-import,
  schema `.parse`, always-runs guard + `skipIf(!dbConfigured)` live-DB, inlined
  `authedContext`/`cookieStub`, happy-dom only), referencing
  `src/actions/predictions.test.ts` as the reference.
- §6.6: add "Phase 3 — Kickoff-lock & action mutations (<date>)" summarizing the new
  action file + the DB boundary write-flip case, and the assert-code+branch
  convention.
- §3 table: Phase 3 Status → `complete`.

### Success Criteria:

#### Automated Verification:

- Live-DB suite (incl. the new boundary case) passes: `npm test -- rls` against the
  local stack (under Node 22).
- Default suite still green with no DB: `npm test`.
- Lint passes: `npm run lint`.

#### Manual Verification:

- The new boundary case is observed crossing kickoff (polls, then the write is
  locked) rather than passing trivially.
- §6.3 reads as a usable recipe for a future contributor adding an action test.

---

## Testing Strategy

### Integration Tests:

- `src/actions/predictions.test.ts` — action-layer kickoff-lock + caller-scoping
  (live DB) and unauthorized guard (always runs).
- `src/db/predictions.rls.test.ts` — DB-layer near-boundary write-flip.

### Manual Testing Steps:

1. `npm test` with no Supabase env → predictions always-runs lane executes, live
   lanes skip; suite green.
2. `npx supabase start`; run with the four `SUPABASE_*` env vars (Node 22):
   `npm test -- predictions` then `npm test -- rls` → all green.
3. Sanity: confirm a post-kickoff case fails for the RLS reason, not only the app
   pre-check.

## Migration Notes

None — test-only change. No schema, RLS, or production code changes.

## References

- Related research: `context/changes/testing-kickoff-lock-actions/research.md`
- Test plan: `context/foundation/test-plan.md` (§2 Risks #3/#4, §3 Phase 3, §6.3/§6.6)
- Reference tests: `src/actions/account.test.ts:68-152`, `src/actions/results.test.ts:18-60`,
  `src/db/predictions.rls.test.ts:328-372`
- Handler under test: `src/actions/index.ts:503-543`; schema `src/lib/schemas/prediction.ts:14-18`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Action-layer predictions.upsert tests

#### Automated

- [x] 1.1 Type checking passes: `npm run lint`
- [x] 1.2 Default suite green with no DB (always-runs lane runs, live lane skips): `npm test`
- [x] 1.3 Live-DB lane passes: `npm test -- predictions` against local stack (Node 22)

#### Manual

- [x] 1.4 Always-runs UNAUTHORIZED test is executed (not skipped) under plain `npm test`
- [x] 1.5 Post-kickoff cases fail for the RLS zero-row reason, not only the app pre-check

### Phase 2: DB boundary write-flip + cookbook

#### Automated

- [ ] 2.1 Live-DB suite incl. new boundary case passes: `npm test -- rls` (Node 22)
- [ ] 2.2 Default suite still green with no DB: `npm test`
- [ ] 2.3 Lint passes: `npm run lint`

#### Manual

- [ ] 2.4 Boundary case observed crossing kickoff (polls, then write locked), not trivially passing
- [ ] 2.5 §6.3 reads as a usable recipe for a future contributor
