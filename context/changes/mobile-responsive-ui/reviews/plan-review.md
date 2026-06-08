<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Mobile-Responsive UI Across All Pages

- **Plan**: context/changes/mobile-responsive-ui/plan.md
- **Mode**: Deep
- **Date**: 2026-06-08
- **Verdict**: SOUND (one quick clarification worth making before build)
- **Findings**: 0 critical, 1 warning, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING |
| Plan Completeness | PASS |

## Grounding

21/21 paths ✓, table class 4/4 ✓ (`w-full text-left text-sm` shared by leaderboard / own history / others' history / admin participants), symbols ✓ (`PredictionList` card idiom `:45-48`, `LockedScore` `:21-28,:55`, dashboard card/nav/sign-out lines), brief↔plan ✓. No `docs/reference/contract-surfaces.md` (skipped). All 15 existing test files are DB/RLS/lib/schema/action/middleware tests — none render components or `.astro` pages — so the dual-render (mobile card + desktop table both in the happy-dom DOM) introduces no `getByText`-duplication risk to `npm run test`.

## Findings

### F1 — "Tap-friendly controls" bar is undefined; some controls stay sub-44px

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Desired End State + Phase 3 + Testing Strategy
- **Detail**: FR-025 and roadmap S-08 explicitly require "tap-friendly form controls" and "touch targets sized for small screens" (must-have). The research (plan §Current State lines 17 / 36) flags shadcn `size="sm"` buttons at h-8 (32px) — the MatchList Edit/Cancel/Delete — and calendar day cells (~32px) as below the 44px guideline. Phase 3 fixes only the password toggle (change 6) and some submit widths; it scopes out primitive tap-target uplift and never decides what to do about the 32px sm-buttons and calendar cells, yet the success criteria/manual checks say controls are "comfortably tappable" with no defined threshold. The criterion can be ticked subjectively while real controls remain hard to tap — and calendar cells can't be fixed at a call site (they live in the Calendar primitive, which the plan correctly won't hand-edit).
- **Fix**: State the tap-target bar the plan commits to and resolve the two known offenders explicitly. e.g. add a Phase 3 line: bump the MatchList Edit/Cancel/Delete from `size="sm"` to default (a call-site change, in-scope) so they reach h-9; and explicitly accept the ~32px calendar day cells as a documented exception (uplift would require editing the shadcn primitive, out of scope).
  - Strength: Makes a must-have criterion testable instead of subjective; the sm→default bump is a pure call-site edit consistent with the plan's "tap-target fixes happen at call sites."
  - Tradeoff: Slightly taller secondary buttons on desktop too (h-8→h-9); acceptable and arguably an improvement.
  - Confidence: HIGH — call-site size override needs no `ui/` edit; matches the plan's stated approach.
  - Blind spot: Whether the group's devices use the calendar picker enough for 32px cells to matter — unverified, hence "accept + document" rather than force a primitive change.
- **Decision**: FIXED — added a tap-target bar to Implementation Approach, Phase 3 change 8 (drop `size="sm"` on MatchList Edit/Cancel + DeleteParticipantButton), criterion 3.7, and accepted Calendar cells as a documented exception.

### F2 — TournamentForm not mentioned in Phase 3 coverage

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 3 (Forms & interactive controls)
- **Detail**: /admin hosts TournamentForm, MatchForm, BulkPasteImport, and MatchList. Phase 3 covers the latter three but never names TournamentForm — not even to say "verified full-width-safe, no change." Research (plan §Forms line 98) does conclude it's safe, but the omission means a reader auditing /admin coverage (and lessons.md's "name benign untouched support files") can't tell whether it was considered or missed.
- **Fix**: Add one line to Phase 3 noting TournamentForm uses full-width default inputs and is intentionally left unchanged.
- **Decision**: FIXED — added an "Intentionally left unchanged" note to the Phase 3 overview naming TournamentForm as verified full-width-safe.
