# Blindness & Ownership at the DB Boundary — Implementation Plan

## Overview

Test rollout Phase 2 of `context/foundation/test-plan.md`. Extend the existing predictions RLS suite to prove three DB-boundary invariants that protect the product's core integrity guarantee:

- **#1** — a participant's (or the admin's) prediction is not visible to anyone else before kickoff, and becomes visible to all after kickoff.
- **#3** — one participant cannot create/edit/delete another's prediction (IDOR / ownership); a spoofed owner id is rejected.
- **#5** — the service-role client is confined to participant lifecycle and never reads predictions.

The work is almost entirely **adding tests**. The enforcement code already exists and is correct (verified in `research.md`); this phase pins it so a future regression fails loudly.

## Current State Analysis

- Blindness is enforced solely by RLS in `supabase/migrations/20260604184657_predictions_with_blindness.sql:78-92`:
  - SELECT `using (predictor_id = auth.uid() or public.match_is_kicked_off(match_id))`
  - INSERT/UPDATE bind `predictor_id = auth.uid() and not match_is_kicked_off(match_id)`
  - **No DELETE policy** (`:74-75`) → user delete is default-denied.
  - **No `is_admin()` branch** (`:7-11`) → admin is blind too (FR-017).
- `match_is_kicked_off` (`:60-71`) is `SECURITY DEFINER`, `stable`, comparing `public.matches.kickoff_time <= now()` (Postgres clock, evaluated per-row at fetch).
- Ownership defense-in-depth: `predictions.upsert` sets `predictor_id: user.id` from session (`src/actions/index.ts:459-460`); the input schema has no owner field (`src/lib/schemas/prediction.ts:14-18`). Identity chain: `auth.uid()` = `profiles.id` = `predictions.predictor_id`.
- Service-role client `createAdminAuthClient` reads its key only via `astro:env/server` (`src/lib/supabase-admin.ts:2,23-33`); **1 production importer** (`src/actions/index.ts:14`), 2 auth-only call sites (`createUser`, `deleteUser`); never `.from("predictions")`.
- Existing test foothold `src/db/predictions.rls.test.ts` already covers: owner reads own pre-kickoff (`143-153`), B/admin blind pre-kickoff (`155-175`), post-kickoff reveal to B/admin (`177-199`), kickoff write-lock (`201-235`), unique constraint (`237-245`).

### Key Discoveries:

- The harness is duplicated per file — no shared module. Conventions: `freshClient(key)` / `signedInClient(email,pwd)` (`predictions.rls.test.ts:46-57`), service-role `auth.admin.createUser` for participants, seeded `admin@betcup.local` for admin, future = `now+7d` / past = `now-1h` fixtures (`:102-106`), `describe.skipIf(!dbConfigured)` where `dbConfigured = Boolean(SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY)` (`:37`).
- Assertion idioms: blindness / UPDATE-lock → `expect(error).toBeNull(); expect(data ?? []).toHaveLength(0)`; INSERT WITH-CHECK violation → `expect(error).not.toBeNull()`; success → `expect(data).toHaveLength(1)`. RLS tests never assert Postgres `error.code`.
- `lessons.md:12-17`: secret-isolation must be asserted against **production reads / importer count** (exclude `*.test.*`), never a raw `rg "SERVICE_ROLE" src` — test harnesses reference the key name and produce false positives.
- The default `npm test` (`ci` job) runs all `*.test.ts`; the skip-gated describe self-skips without a DB. A non-gated describe in the same file therefore runs in **both** the `ci` (no DB) and `rls` (DB up) jobs — the right home for the #5 static assertion.
- CI already runs `npm test -- rls` against a real Postgres (`.github/workflows/ci.yml:86-116`); test-plan §5 marks the RLS gate "required after §3 Phase 2". No new CI wiring is expected — the new tests inherit the existing job by filename.

## Desired End State

`npm test -- predictions.rls` (with the local Supabase stack up) exercises, in addition to today's cases:
- B cannot INSERT a prediction owned by A, cannot UPDATE A's row, cannot DELETE A's row.
- A non-owner querying a future match's predictions without an owner filter gets zero of A's rows.
- An unauthenticated client gets zero prediction rows.
- A match crossing kickoff during the test flips from blind (0 rows for B) to revealed (1 row for B).

`npm test` (no DB) runs the #5 isolation guard: exactly one production reader of the service-role key and one importer of the admin client, with no predictions access on the service-role client.

Test-plan §6.2 / §6.6 are filled in for Phase 2, and Phase 2 status is `complete`.

## What We're NOT Doing

- **Not** re-testing the already-covered cases (owner pre-kickoff read, B/admin blindness, post-kickoff reveal, kickoff write-lock, unique constraint) — they exist and pass.
- **Not** testing the `predictions.upsert` action wrapper for IDOR — the schema makes owner spoofing inexpressible at that layer, and action-layer coverage belongs to Phase 3. This phase asserts at the RLS layer (the last line of defense).
- **Not** adding a new test file — everything lands in `src/db/predictions.rls.test.ts`.
- **Not** changing any production code, migration, or RLS policy. If a test reveals the policy is wrong, that's a separate change.
- **Not** adding new CI jobs — reuse the existing `ci` and `rls` jobs.
- **Not** encrypting predictions at rest or addressing the trusted-admin-with-DB-access threat (explicitly out of scope per PRD FR-015 Socratic note).

## Implementation Approach

Two phases. Phase 1 adds the live-DB RLS tests inside the existing skip-gated `describe`, reusing its `beforeAll` fixtures and adding only the extra rows each new case needs. Phase 2 adds a separate non-gated `describe` for the static #5 isolation guard and closes out the test-plan cookbook + ledger. The phases are independent (Phase 2 needs no DB) and could even run in either order, but Phase 1 is the heart of the risk response.

## Critical Implementation Details

- **The #5 guard must NOT be inside the `skipIf(!dbConfigured)` block** — if it were, it would silently skip in the default `ci` job, which is exactly the environment where catching a new service-role importer matters most. Put it in its own top-level `describe` with no skip guard.
- **Near-boundary kickoff test is flake-sensitive.** Use a short-but-safe lead (e.g. ~2–3s), and after asserting "blind", **poll/wait until `now()` is safely past the seeded `kickoff_time`** (with a small buffer) before asserting "revealed" — rather than a single fixed `sleep` that could fire a hair early. A's prediction on this match must be inserted **before** kickoff (participant session, real INSERT policy). Keep the whole near-boundary scenario in one `it` so the crossing is observed on the same row.
- **DELETE has no policy**, so a B-delete attempt returns success-with-zero-rows (USING matches nothing) rather than an error; assert `data` is empty, not that `error` is non-null. Confirm the exact shape during implementation and assert whichever the client returns (zero rows affected).

## Phase 1: Ownership/IDOR + blindness-edge tests (RLS, live DB)

### Overview

Extend the skip-gated `describe` in `src/db/predictions.rls.test.ts` with the adversarial ownership cases (#3), the unfiltered-list and anon blindness edges (#1), and the near-boundary kickoff crossing (#1).

### Changes Required:

#### 1. Predictions RLS suite — new test cases

**File**: `src/db/predictions.rls.test.ts`

**Intent**: Add `it(...)` blocks (and any minimal extra fixtures they need, e.g. one more future match for an isolated near-boundary crossing) inside the existing `describe.skipIf(!dbConfigured)` block, reusing `participantA`, `participantB`, `admin`, `service`, and the existing match/prediction fixtures. Cover the gaps research identified for #1 and #3.

**Contract**: New cases, using the file's existing assertion idioms:
- *#3 spoofed-owner INSERT*: as `participantB`, `insert({ predictor_id: aUserId, match_id: futureMatchId, ... })` → `expect(error).not.toBeNull()` (WITH CHECK `predictor_id = auth.uid()` violated).
- *#3 cross-owner UPDATE*: as `participantB`, `update(...).eq("predictor_id", aUserId).eq("match_id", futureMatchId)` → `error` null, `data` zero rows (USING filters A's row out).
- *#3 cross-owner DELETE*: as `participantB`, `delete().eq("predictor_id", aUserId)` → zero rows affected (no DELETE policy). Assert the empty result; do not assume an error.
- *#1 unfiltered list*: as `participantB`, `select("predictor_id, home_goals, away_goals").eq("match_id", futureMatchId)` (no owner filter) → must NOT contain A's row (length 0 given only A has predicted that future match). Proves blindness isn't bypassed by dropping the owner filter.
- *#1 anon denial*: an anon-key client with **no** sign-in selecting predictions → zero rows (policy is `to authenticated` only).
- *#1 near-boundary crossing*: seed a dedicated match with `kickoff_time ≈ now + ~2-3s`; A inserts a prediction pre-kickoff; assert `participantB` sees 0 rows; wait until safely past kickoff; assert `participantB` now sees exactly 1 row with A's values. Single `it`, polling the wait per Critical Implementation Details.

**Note**: extend `afterAll` only if a new tournament/match fixture is created outside the existing `tournamentId` cascade; prefer hanging new matches off the existing `tournamentId` so teardown stays a single cascade.

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- Full suite passes with local DB up: `npm run db:start` then `SUPABASE_DB_URL=… SUPABASE_URL=… SUPABASE_ANON_KEY=… SUPABASE_SERVICE_ROLE_KEY=… npm test -- predictions.rls`
- The new #3 INSERT-spoof, cross-owner UPDATE, cross-owner DELETE, unfiltered-list, anon-denial, and near-boundary crossing cases are present and green.
- No regression in the existing predictions.rls cases.

#### Manual Verification:

- Sanity-check the near-boundary test for flakiness by running `npm test -- predictions.rls` a few times locally; confirm it does not intermittently fail at the crossing.
- Confirm each new test fails for the right reason if the policy were wrong (e.g. temporarily relax a predicate locally, see the test go red, revert) — optional but recommended for the IDOR cases.

**Implementation Note**: After completing this phase and all automated verification passes, pause for human confirmation that the manual flake check was successful before proceeding to Phase 2.

---

## Phase 2: Service-role isolation guard (static) + cookbook & ledger

### Overview

Add the #5 isolation invariant as a static, no-DB test (so it runs in the default `ci` job), then fill the test-plan cookbook/ledger for Phase 2.

### Changes Required:

#### 1. Service-role isolation guard

**File**: `src/db/predictions.rls.test.ts`

**Intent**: Add a new **top-level, non-skip-gated** `describe("service-role isolation (static)", …)` that reads production source and asserts the service-role blast radius, encoding `lessons.md` (production reads / importer count, excluding `*.test.*`). This guards against a future second importer or a `.from("predictions")` creeping onto the admin client.

**Contract**: Static assertions over source files (no Supabase connection):
- Exactly one production reader of `SUPABASE_SERVICE_ROLE_KEY` via `astro:env/server` → `src/lib/supabase-admin.ts`.
- Exactly one production importer of `@/lib/supabase-admin` / `createAdminAuthClient` → `src/actions/index.ts`.
- `src/lib/supabase-admin.ts` performs no `.from("predictions")` (and, ideally, no data-table `.from(` at all — it is auth-only).
- All scans exclude `*.test.*` and `test/`.

A small contract snippet for the importer-count assertion (the file-scan shape is the non-obvious part — the implementer fills exact glob/read mechanics):

```ts
// excludes *.test.* and test/ — see lessons.md (production reads, not raw grep)
const prodImporters = sourceFiles
  .filter((f) => !/\.test\.[tj]sx?$/.test(f) && !f.includes("/test/"))
  .filter((f) => /@\/lib\/supabase-admin|createAdminAuthClient/.test(read(f)));
expect(prodImporters).toEqual(["src/actions/index.ts"]); // count === 1
```

#### 2. Test-plan cookbook + ledger

**File**: `context/foundation/test-plan.md`

**Intent**: Fill the Phase-2 TBD slots now that the pattern is concrete, and advance the rollout status.

**Contract**:
- §6.2 "Blindness/ownership specifics" — replace the TBD with the concrete pattern (skip-gated RLS describe + non-gated static isolation guard; the spoof/anon/near-boundary idioms; the `lessons.md` importer-count rule).
- §6.6 — add a per-phase note for Phase 2.
- §3 Phase 2 Status → `complete`.
- §5 "RLS tests vs real Postgres" gate — confirm wording reflects it is now enforced (it already runs in CI).

### Success Criteria:

#### Automated Verification:

- Lint passes: `npm run lint`
- The isolation guard runs and passes **without** a DB: `npm test -- predictions.rls` with no `SUPABASE_*` env set (the skip-gated RLS describe skips; the static describe runs green).
- The guard fails if a second importer is introduced (verify by temporarily adding a throwaway import in a non-test file, see red, revert).
- Full suite green in the DB-up configuration: `npm test -- rls` with the stack running.

#### Manual Verification:

- Read §6.2 / §6.6 of `test-plan.md` and confirm a future contributor could write the next blindness/ownership test from the cookbook alone.
- Confirm `git grep`-style intuition matches the guard: only `src/lib/supabase-admin.ts` reads the key, only `src/actions/index.ts` imports the admin client.

**Implementation Note**: After completing this phase and automated verification passes, pause for human confirmation before marking the change complete.

---

## Testing Strategy

### Unit / static Tests:

- Service-role isolation guard (no DB): importer/reader counts, no predictions access on the admin client.

### Integration Tests (RLS vs live Supabase):

- #3: spoofed-owner INSERT denied; cross-owner UPDATE zero rows; cross-owner DELETE zero rows.
- #1: unfiltered-list blindness; anon-SELECT denial; near-boundary kickoff crossing (blind → revealed on the same row).
- Existing cases (regression): owner/peer/admin blindness, post-kickoff reveal, write-lock, unique.

### Manual Testing Steps:

1. `npm run db:start`, capture anon + service keys from `npx supabase status`.
2. Run `npm test -- predictions.rls` with all four env vars; confirm all new cases green.
3. Re-run 3–5× to confirm the near-boundary test is stable.
4. Run `npm test -- predictions.rls` with **no** env to confirm the static guard runs while the RLS describe skips.

## Performance Considerations

Negligible. The only cost is the ~2–3s wait in the near-boundary test; keep the lead small and poll rather than over-sleeping to bound suite time.

## Migration Notes

None — no schema or production-code changes.

## References

- Related research: `context/changes/testing-blindness-ownership/research.md`
- Test plan (Phase 2 + §6.2 cookbook): `context/foundation/test-plan.md:93,160-168`
- Enforcement: `supabase/migrations/20260604184657_predictions_with_blindness.sql:60-92`
- Harness to mirror: `src/db/predictions.rls.test.ts:33-141`
- Lessons (isolation assertion): `context/foundation/lessons.md:12-17`
- Service-role client: `src/lib/supabase-admin.ts`; sole importer `src/actions/index.ts:14`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Ownership/IDOR + blindness-edge tests (RLS, live DB)

#### Automated

- [x] 1.1 Lint passes: `npm run lint`
- [x] 1.2 Full suite passes with local DB up: `npm test -- predictions.rls` (all four `SUPABASE_*` env vars set)
- [x] 1.3 #3 INSERT-spoof, cross-owner UPDATE, cross-owner DELETE cases present and green
- [x] 1.4 #1 unfiltered-list, anon-denial, near-boundary crossing cases present and green
- [x] 1.5 No regression in existing predictions.rls cases

#### Manual

- [x] 1.6 Near-boundary test run 3–5× locally with no intermittent failure
- [x] 1.7 (Optional) IDOR cases verified to fail for the right reason via temporary policy relaxation

### Phase 2: Service-role isolation guard (static) + cookbook & ledger

#### Automated

- [ ] 2.1 Lint passes: `npm run lint`
- [ ] 2.2 Static isolation guard passes with NO DB env (`npm test -- predictions.rls`; RLS describe skips, static describe green)
- [ ] 2.3 Guard fails when a second importer is introduced (verify then revert)
- [ ] 2.4 Full suite green with DB up: `npm test -- rls`

#### Manual

- [ ] 2.5 §6.2 / §6.6 of test-plan.md readable as a standalone cookbook entry; Phase 2 status → complete
- [ ] 2.6 Importer/reader intuition matches the guard (only supabase-admin.ts reads key, only actions/index.ts imports it)
