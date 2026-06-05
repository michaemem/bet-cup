<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Delete Participant (S-06)

- **Plan**: context/changes/delete-participant/plan.md
- **Mode**: Deep
- **Date**: 2026-06-05
- **Verdict**: REVISE → SOUND (all findings fixed 2026-06-05)
- **Findings**: 0 critical, 2 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | WARNING |
| Blind Spots | WARNING |
| Plan Completeness | PASS |

## Grounding

6/6 paths ✓ (participant.ts, actions/index.ts, supabase-admin.ts, admin/participants.astro, participants.test.ts, ParticipantForm.tsx), symbols ✓ (`profiles_delete`:174, `user_roles_select`:181, `requireAdmin`/`adminClient`/`createAdminAuthClient`), brief↔plan ✓. Verified: zod v4 (`^4.4.3`) with codebase using `z.uuid()`; supabase-js `deleteUser(id, shouldSoftDelete = false)` defaults to hard delete.

## Findings

### F1 — Cascade premise depends on a HARD delete; not made explicit

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 1, change #2 (step 4)
- **Detail**: The "free cascade" premise requires deleting the `auth.users` row. supabase-js exposes `deleteUser(id, shouldSoftDelete = false)`: a SOFT delete keeps the `auth.users` row, so the `ON DELETE CASCADE` to profiles/predictions would NOT fire and the participant would linger on the leaderboard. The default (`false` = hard delete) is correct, but the plan never states the call must be the bare `deleteUser(id)` and must never pass `shouldSoftDelete: true`. A future "ban instead of delete" tweak could silently defeat the cascade.
- **Fix**: In Phase 1 step 4, state the call is `admin.auth.admin.deleteUser(input.id)` with the default hard delete (never `shouldSoftDelete: true`), and add a Phase 3 assertion that the `auth.users` row itself is gone (not just the profile) — proving a hard delete occurred.
- **Decision**: FIXED — Phase 1 step 4 now mandates the bare hard-delete call; Phase 3 cascade test asserts `getUserById` returns no user.

### F2 — Schema uses z.string().uuid() instead of the codebase's z.uuid()

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architectural Fitness
- **Location**: Phase 1, change #1 (`participantDeleteSchema`)
- **Detail**: The repo is on zod v4 (`package.json: "zod": "^4.4.3"`) and every existing schema uses the top-level `z.uuid()` — `result.ts:14`, `prediction.ts:15`, `match.ts:57`. The plan specifies `z.object({ id: z.string().uuid() })`; in zod v4 the string-method form is the deprecated path and deviates from the established convention (and could trip the strict-type-checked lint gate).
- **Fix**: Specify `z.object({ id: z.uuid() })` to match `result.ts` / `prediction.ts` / `match.ts`.
- **Decision**: FIXED — schema contract changed to `z.object({ id: z.uuid() })`.

### F3 — deleteUser "not-found" error shape left to the implementer

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1, change #2 (step 4)
- **Detail**: Step 4 says "treat a not-found error as idempotent success" without naming the error shape (code/status), unlike create's precise `email_exists` / 422 handling. This is low-risk because step 2's zero-role-rows check already returns idempotent success before `deleteUser` is reached, so the `deleteUser` not-found branch only fires in a rare delete-between-read-and-delete race.
- **Fix**: Acceptable as-is given the upstream idempotency guard; optionally note that any `deleteUser` error after the role check is logged via `internalError` (the race is rare and the data is already consistent).
- **Decision**: FIXED — step 4 now states idempotency is handled upstream (step 2); any `deleteUser` error → `internalError`, no special not-found branch.
