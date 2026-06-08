# Blindness & Ownership at the DB Boundary — Plan Brief

> Full plan: `context/changes/testing-blindness-ownership/plan.md`
> Research: `context/changes/testing-blindness-ownership/research.md`

## What & Why

Test rollout Phase 2: prove the three DB-boundary invariants that protect BetCup's core integrity guarantee — predictions are blind before kickoff (#1), only the owner can mutate them (#3), and the service-role client never reads them (#5). The enforcement code already exists and is correct; this phase pins it with tests so a future regression fails loudly.

## Starting Point

`src/db/predictions.rls.test.ts` already covers owner/peer/admin blindness, post-kickoff reveal, the kickoff write-lock, and the unique constraint. RLS in `20260604184657_predictions_with_blindness.sql` enforces blindness via `predictor_id = auth.uid() OR match_is_kicked_off(match_id)` (no `is_admin()` branch); the service-role client has one production importer and never touches predictions. The gaps are the adversarial and edge cases.

## Desired End State

The predictions RLS suite additionally proves: B cannot insert/update/delete A's prediction, a non-owner's unfiltered query excludes A's row, an anon client sees zero rows, and a match crossing kickoff mid-test flips from blind to revealed. A separate no-DB guard asserts the service-role blast radius stays at one importer/reader with no predictions access. Test-plan §6.2/§6.6 are filled and Phase 2 is marked complete.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Where tests live | Extend `predictions.rls.test.ts` | One source of truth for the predictions policy; reuses existing fixtures | Plan |
| #3 test layer | DB/RLS raw-client spoof | Proves the guarantee at the last line of defense, survives action refactors | Plan |
| #5 assertion | Static Vitest importer/reader-count guard | Encodes `lessons.md` (production reads, not raw grep); runs without a DB | Research + Plan |
| #5 guard placement | Non-skip-gated `describe` in same file | Must run in the default `ci` job, where a new importer matters most | Plan |
| Kickoff edge | Near-boundary crossing test (poll the wait) | Proves `now()` is evaluated live per-fetch, not cached | Plan |
| Anon access | Add an anon-SELECT denial test | Cheap; guards the `to authenticated` role-scoping | Plan |

## Scope

**In scope:** B-spoof INSERT/UPDATE/DELETE against A; unfiltered-list blindness; anon-SELECT denial; near-boundary kickoff crossing; static service-role isolation guard; test-plan cookbook/ledger update.

**Out of scope:** Re-testing already-covered cases; action-layer IDOR (Phase 3); any production-code/migration/RLS change; new CI jobs; encrypt-at-rest / trusted-admin threat (PRD-excluded).

## Architecture / Approach

Two independent phases in `src/db/predictions.rls.test.ts`: (1) new `it()` cases inside the existing `describe.skipIf(!dbConfigured)` block, reusing its A/B/admin/service clients and future/past fixtures; (2) a new top-level non-gated `describe` doing static source assertions, plus the test-plan doc updates. New tests inherit the existing CI `rls` (DB) and `ci` (no-DB) jobs by filename — no CI wiring needed.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. IDOR + blindness edges | #3 spoof/UPDATE/DELETE, unfiltered-list, anon, near-boundary crossing (live DB) | Near-boundary test flake if the wait isn't polled past kickoff |
| 2. Service-role guard + docs | Static importer/reader-count guard (no DB); §6.2/§6.6 cookbook; Phase 2 → complete | Static scan over-/under-matching if test files aren't excluded |

**Prerequisites:** Local Supabase stack (`npm run db:start`) + anon/service keys for Phase 1; none for Phase 2's static guard.
**Estimated effort:** ~1 session across 2 phases.

## Open Risks & Assumptions

- The near-boundary crossing test is time-based; mitigated by a small lead + polling past kickoff, but watch for CI flake.
- DELETE returns zero-rows (no policy) rather than an error — assert the empty result, confirm shape during implementation.
- The static guard couples to file paths/import strings; legitimate refactors will require updating it (acceptable — that's the point of the invariant).

## Success Criteria (Summary)

- A non-owner (and anon) provably cannot read A's pre-kickoff prediction, and cannot create/edit/delete it.
- A match crossing kickoff during a test flips from blind to revealed on the same row.
- The service-role client is provably confined to one importer/reader with no predictions access, enforced in the default test run.
