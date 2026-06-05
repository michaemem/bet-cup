<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Account Settings — Change Password & Display Name

- **Plan**: context/changes/participant-changes-password/plan.md
- **Scope**: All 3 phases (full plan)
- **Date**: 2026-06-05
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 4 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Evidence Summary

- All 12 changed files map to the plan; no unplanned source files (only `prd.md`, `roadmap.md` docs + the 10 planned files).
- Both plan-review fixes landed: `verifyCurrentPassword` uses a transient `persistSession: false` client (F1/Fix B from plan review) and splits `invalid_credentials` from other errors (F4). Call order verify → `updateUser` → `signOut({ scope: "others" })` is correct; display-name update is column-scoped to `{ display_name }`.
- Automated criteria: `npm run lint` → 0 errors (19 pre-existing `no-console` warnings, unrelated); `npx vitest run src/lib/schemas/account.test.ts` → 9/9 pass; `npm run build` → success (Node 22.14.0). `npx vitest run src/actions/account.test.ts` → 3 self-skipped (no local Supabase stack; by design, mirroring `participants.test.ts`), recorded passing at commit `a25e1e1`.

## Findings

### F1 — Roadmap S-07 still reads "proposed" / "deferred"

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: context/foundation/roadmap.md:39 (At a glance row), :184 (Backlog Handoff row)
- **Detail**: Phase 3 updated the S-07 outcome text + PRD refs, but the lifecycle status column still says "proposed" and the Backlog Handoff row still says "deferred under main_goal: speed", even though the slice is fully implemented. Soft tension with criterion 3.3 ("no contradictions between PRD, roadmap, and implemented actions"). Every other completed slice (S-01..S-05) only flips to "done" once archived, so this likely resolves at `/10x-archive` — but right now an implemented feature reads as not-started.
- **Fix**: At archive time (or now), set the S-07 status to done/implemented and refresh the Backlog Handoff note to reflect shipped state.
- **Decision**: FIXED — roadmap.md S-07 "At a glance" status set to `done`; Backlog Handoff note updated to "Landed — `/settings` page; both roles change their own password + display name".

### F2 — Integration test omits the other-session sign-out behavior

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: src/actions/account.test.ts:197-223
- **Detail**: The plan's Testing Strategy lists "other-session behavior" as an account integration case, but the implemented password test only asserts new-pass-works / old-pass-fails. The security-critical "`signOut(others)` revokes other devices while the current one survives" property is verified only by manual gate 1.6. The Phase 1 §4 Contract case list did not require it, and multi-session state is genuinely hard to assert in this harness — so this is a coverage gap, not a defect.
- **Fix**: Optionally add a case that signs the user in on a second client, runs `changePassword`, and asserts the second session's refresh token is revoked while the acting context still mutates.
- **Decision**: FIXED — added integration case "signs out other devices on password change (their refresh token is revoked)" in src/actions/account.test.ts; mints a second session, runs `changePassword`, asserts `refreshSession` on the other token fails. Self-skips without a local DB (lint + type-check pass).

### F3 — verifyCurrentPassword treats any HTTP 400 as "wrong password"

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/actions/index.ts:131
- **Detail**: The guard is `error.code === "invalid_credentials" || error.status === 400`. The code check is correct; the `status === 400` fallback would also classify any other GoTrue 400 (e.g. a validation/bad-request shape) as "Current password is incorrect.", which the Error-discipline note wants routed to `internalError`. Low risk — invalid creds is the dominant 400 on this path — but the fallback slightly widens the field-error class.
- **Fix**: Prefer matching on `error.code === "invalid_credentials"` alone (keep 400 only as a secondary signal if code is absent).
- **Decision**: FIXED — guard narrowed to `error.code === "invalid_credentials" || (!error.code && error.status === 400)` in src/actions/index.ts, so other GoTrue 400s route to `internalError`.

### F4 — Success UX uses a delayed reload, not the plan's immediate reload

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/components/account/DisplayNameForm.tsx:44-47, src/components/account/ChangePasswordForm.tsx:40-43
- **Detail**: Plan said "inline success message + `window.location.reload()`". `PredictionForm` reloads immediately; here both forms show the message then `setTimeout(reload, 1200/1500ms)` and disable the button on success. This is a deliberate, benign improvement (lets the user see the message) — flagged only as a documented deviation from the existing convention.
- **Fix**: None needed — accept as an intentional enhancement.
- **Decision**: ACCEPTED — delayed reload kept as an intentional UX enhancement (shows the success message before reloading).
