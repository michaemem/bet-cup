<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Admin Resets a Participant's Password (S-09)

- **Plan**: context/changes/admin-reset-participant-password/plan.md
- **Scope**: Full plan (Phases 1–4 of 4)
- **Date**: 2026-06-09
- **Verdict**: NEEDS ATTENTION (triaged 2026-06-09 — F1 fixed, F2 accepted, F3 fixed)
- **Findings**: 0 critical · 2 warnings · 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Success-criteria checks run live during this review: `npm run lint` (0 errors, 19 pre-existing no-console warnings), `npm test` (78 passed / 66 skipped — matches recorded Phase 4), `npm run check:wrangler` (OK). Live-DB suite and `npm run build` rely on the recorded Phase 4 SHAs (132ee6b).

## Findings

### F1 — resetPassword hard-depends on a migration prod won't auto-apply

- **Severity**: ⚠️ WARNING
- **Impact**: 🔬 HIGH — architectural stakes; think carefully before deciding
- **Dimension**: Safety & Quality (Reliability)
- **Location**: src/actions/index.ts:315-321 + supabase/migrations/20260608155006_revoke_user_sessions.sql
- **Detail**: CI's deploy job runs only `wrangler deploy`, never `supabase db push` (per the AGENTS.md line this diff adds). The action sets the new password first (:315), then calls `rpc("revoke_user_sessions")` (:318). If the Worker deploys before the migration is manually applied to prod, the RPC hits a missing function → internalError → 500, and `{ password }` (:321) is never returned. Net: old password dead, sessions still live, admin never sees the temp password → participant locked out until the migration lands and the admin retries. The plan's Migration Notes call the migration "forward-only / harmless if left in place" — true for the function itself, but the calling code is NOT backward-compatible with a prod DB that lacks it.
- **Fix**: Gate this feature's release on applying the migration to prod (`npx supabase db push`, preview with `--dry-run`) BEFORE the Worker code that calls the RPC goes live. Add the deploy-order step to the change's runbook/PR checklist — the AGENTS.md note documents the gap but does not enforce ordering.
- **Decision**: FIXED — strengthened plan.md Migration Notes with the explicit migration-before-Worker deploy gate.

### F2 — Unplanned AGENTS.md edit in the feature diff

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: AGENTS.md:50, AGENTS.md:52
- **Detail**: The diff edits AGENTS.md — not in the plan's "Changes Required". Two changes: (a) adds the "Supabase migrations are NOT auto-applied to prod" guidance (directly relevant — it's the gap behind F1), and (b) corrects the production URL (betcup.betcup.workers.dev → betcup.pacs.workers.dev). Both are benign and arguably improvements, but they're unrelated doc edits riding in a feature commit. This is exactly the "unplanned-but-benign support files" class already noted in lessons.md.
- **Fix**: Accept as-is (both edits are correct and the migration note is on-topic). No code action needed; noting for scope hygiene.
- **Decision**: ACCEPTED — both edits correct (migration note on-topic, URL correction); kept as-is.

### F3 — Read-then-write race returns 500 instead of NOT_FOUND

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/actions/index.ts:315-316
- **Detail**: The sibling `delete` action tolerates a user_not_found/404 from deleteUser as idempotent success (:262-263). resetPassword has no equivalent: if the target is deleted between the role read (:297) and updateUserById (:315), GoTrue's not-found error → internalError → generic 500, rather than the clean NOT_FOUND it already returns for the zero-roles case (:302-304). Rare race in a single-admin pool, so genuinely minor.
- **Fix**: Optionally map updateUserById's not-found error to NOT_FOUND for consistency with the zero-roles branch and with delete.
- **Decision**: FIXED — updateUserField not-found (`user_not_found`/404) now maps to NOT_FOUND in resetPassword (src/actions/index.ts:315-324); test guards stay green (78 passed / 66 skipped).

## Notes (did not rise to findings)

- The migration's long justification header comment (docs only, no behavioral effect).
- An extra "rejects a missing id" schema test case in `src/lib/schemas/participant.test.ts` (additive coverage).
- Both are benign/additive and covered by the lessons.md "unplanned-but-benign support files" precedent.
