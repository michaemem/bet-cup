<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Mobile-Responsive UI Across All Pages

- **Plan**: context/changes/mobile-responsive-ui/plan.md
- **Scope**: All 3 phases (full plan)
- **Date**: 2026-06-08
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 3 observations

## Automated gates

- `npm run lint` — PASS (0 errors; 19 pre-existing `no-console` warnings, unrelated)
- `npm run test` — PASS (73 passed, 63 Docker-gated RLS integration skips)
- `npm run build` — PASS (Node 22.14.0; failed only under a stale Node 20 shell)

All 17 changed source files map to planned files. No unplanned source files. Desktop equivalence preserved via the `sm:`-revert convention. `TournamentForm` correctly left untouched (verified absent from diff).

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS (1 observation) |
| Success Criteria | PASS |

## Findings

### F1 — Desktop-regression fix landed outside the plan's Progress

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/pages/dashboard.astro:9 (commit acb92a4)
- **Detail**: The plan's Phase-1 contract said the dashboard card "gains `w-full max-w-sm`". The original card had no width cap (shrink-to-fit), so `max-w-sm` (384px) clips the desktop horizontal nav row of up to 6 links — violating the plan's own "desktop is pixel-equivalent" criterion. The implementer caught this in manual testing and shipped follow-up commit acb92a4 adding `sm:w-auto sm:max-w-none`, restoring desktop. Net result is correct, but (a) the plan contract itself was flawed, and (b) the fix is a standalone commit not reflected in the plan's Progress/addenda. Positive signal: concrete evidence the manual 360px/desktop walk actually happened.
- **Fix**: Add a one-line addendum to plan.md Phase 1 #2 noting the `max-w-sm` cap must be reverted at `sm:` (`sm:w-auto sm:max-w-none`), so the plan matches what shipped.
- **Decision**: FIXED — plan.md Phase 1 #2 contract updated with the `sm:w-auto sm:max-w-none` revert note (cites commit acb92a4).

### F2 — Static className strings where plan contracts said cn()

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: PredictionForm.tsx:107, ResultForm.tsx:107, ChangePasswordForm.tsx:90, DisplayNameForm.tsx:82, BulkPasteImport.tsx:103/111/119, PasswordToggle.tsx:13
- **Detail**: Plan contracts for the score forms, BulkPasteImport, and PasswordToggle said "Composed via cn()", but the call sites use plain literals (e.g. `className="w-full sm:w-auto"`). This is NOT an AGENTS.md violation — that rule forbids manual concatenation/composition, and a single static literal composes nothing. It matches the prevailing convention: most non-`ui` form components (PredictionList, MatchList, etc.) already use plain string classNames for static classes. The code is consistent with the codebase; it only drifts from the plan's stricter wording.
- **Fix**: None needed for the code. Optionally relax the plan wording (static literals — `cn()` adds nothing).
- **Decision**: FIXED — relaxed the three "Composed via `cn()`" contracts in plan.md (lines 189/205/221) to "use `cn()` only when composing conditional classes". No code change.

### F3 — Leaderboard mobile card has no long-name guard

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (layout robustness)
- **Location**: src/pages/leaderboard/index.astro:64-77
- **Detail**: The mobile card is `flex items-center justify-between gap-4` with a linked name on the left and Points/Exact on the right. The name `<a>` has no `min-w-0`/`truncate`/`break-words`. A very long unbroken display name could push the right column and reintroduce overflow at 360px — the "realistic (long) content" case the plan's own risk register calls out. The history/participants cards wrap on whitespace and are safe; this is the one card without a guard. Confidence: MED — depends on whether long names occur; no browser available to confirm a real overflow.
- **Fix**: Add `min-w-0` to the left wrapper and `break-words` (or `truncate`) to the name link.
- **Decision**: FIXED — leaderboard mobile card: left wrapper `min-w-0`, name link `break-words`, right column `shrink-0` (src/pages/leaderboard/index.astro:66-79). Lint re-run clean (0 errors).
