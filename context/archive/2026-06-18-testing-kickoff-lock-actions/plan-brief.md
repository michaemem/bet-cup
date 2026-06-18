# Kickoff-lock & action-layer mutation tests (test-plan Phase 3) — Plan Brief

> Full plan: `context/changes/testing-kickoff-lock-actions/plan.md`
> Research: `context/changes/testing-kickoff-lock-actions/research.md`

## What & Why

Phase 3 of the test rollout. The kickoff write-lock (Risk #4) and ownership
(Risk #3) invariants are enforced and tested at the DB/RLS layer, but the Astro
Action `predictions.upsert` that sits on top of them is untested. We add
action-layer integration tests for it, and close the one DB gap where the kickoff
_boundary_ was only proven for read-blindness, not for a write.

## Starting Point

`predictions.upsert` (`src/actions/index.ts:503-543`) runs on a session client,
derives `predictor_id` from the session, and guards kickoff twice (app pre-check
for a friendly message + race-proof RLS zero-row). There is no
`src/actions/predictions.test.ts`. The DB layer (`src/db/predictions.rls.test.ts`)
already covers post-kickoff write rejection and cross-owner mutation; its
near-boundary test asserts only the SELECT flip.

## Desired End State

A new `src/actions/predictions.test.ts` (always-runs `UNAUTHORIZED` lane + live-DB
core set) and one extra near-boundary write-flip case in `predictions.rls.test.ts`.
`npm test` stays green with no DB; `npm test -- predictions` / `-- rls` pass against
the local stack. Test-plan §6.3/§6.6 documented; §3 Phase 3 marked `complete`.

## Key Decisions Made

| Decision                 | Choice                                                         | Why (1 sentence)                                                                                                | Source   |
| ------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | -------- |
| Scope                    | `predictions.upsert` only; no `results.test.ts` changes        | Result entry/correction already covered by `results-scoring.rls.test.ts`; re-asserting adds no signal           | Plan     |
| Risk #3 at action layer  | Assert caller-scoping, not spoof-rejection                     | Schema has no owner field — spoofing is structurally impossible; spoof test lives at DB layer                   | Research |
| Risk #4 assertion target | Handler translation (NOT_FOUND vs FORBIDDEN), not the DB clock | Authoritative lock is Postgres `now()` via RLS, already DB-tested; action adds the message/zero-row translation | Research |
| DB boundary gap          | Close it — add one write-flip case                             | Boundary was only proven for SELECT; a write-flip is cheap and closes the gap                                   | Plan     |
| Assertion depth          | Error code + which branch fired; not exact message strings     | Messages are UX not contract; branch discrimination is the action layer's value                                 | Plan     |
| Test environment         | Stay on global `happy-dom`, no node pragma                     | supabase-js 2.105.3 throws on client init under node env (known §6.6 bug)                                       | Research |

## Scope

**In scope:** new `src/actions/predictions.test.ts` (unauthorized guard + live-DB
core set: pre-kickoff create/edit success, post-kickoff create/edit → FORBIDDEN,
NOT_FOUND on bad matchId, caller-scoping A≠B); one near-boundary write-flip case in
`src/db/predictions.rls.test.ts`; test-plan §6.3/§6.6 + §3 status.

**Out of scope:** `results.test.ts` changes; re-proving RLS spoof/cross-owner at the
action layer; the supabase-js node-env WebSocket fix; any new CI gate (Phase 4); a
shared test-helper module.

## Architecture / Approach

Mirror the existing two-lane action-test harness (`account.test.ts`,
`results.test.ts`): reach the real handler via dynamic import + cast, validate
input through the Zod schema, run an always-runs guard lane (throws before DB) and
a `describe.skipIf(!dbConfigured)` live-DB lane with an inlined cookie-jar session
context. Fixtures (participants A/B, future + past match) follow the
`predictions.rls.test.ts` `beforeAll` idioms. Assertions check error code + branch.

## Phases at a Glance

| Phase                     | What it delivers                                             | Key risk                                                                 |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 1. Action-layer tests     | `src/actions/predictions.test.ts` (guard + live-DB core set) | Cookie-jar/happy-dom session wiring must match `account.test.ts` exactly |
| 2. DB boundary + cookbook | Near-boundary write-flip case; §6.3/§6.6 + §3 status         | Timing flake — must poll until kickoff, never a fixed sleep              |

**Prerequisites:** local Supabase stack (`npx supabase start`) and Node 22 for the
live-DB lanes; the four `SUPABASE_*` env vars.
**Estimated effort:** ~1-2 sessions across 2 phases.

## Open Risks & Assumptions

- Live-DB lanes self-skip without env, so a misconfigured local run can silently
  skip coverage — Phase 1 manual check confirms the always-runs lane executes.
- Boundary write-flip is timing-sensitive; the poll-until-kickoff idiom (not a
  fixed sleep) is load-bearing to avoid flake.
- Node 20 fails the supabase-js WebSocket init; live lanes assume the repo-pinned
  Node 22.

## Success Criteria (Summary)

- `predictions.upsert` kickoff lock, NOT_FOUND/FORBIDDEN discrimination, and
  caller-scoping are pinned at the action layer; unauthorized guard runs in default CI.
- The kickoff boundary is proven for a write, not just a read.
- A future contributor can follow §6.3 to add an action test without re-deriving the harness.
