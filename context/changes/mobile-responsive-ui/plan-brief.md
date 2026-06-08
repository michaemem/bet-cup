# Mobile-Responsive UI Across All Pages — Plan Brief

> Full plan: `context/changes/mobile-responsive-ui/plan.md`
> Research: `context/changes/mobile-responsive-ui/research.md`

## What & Why

Make every BetCup page usable on a phone (~360px): no horizontal overflow, tap-friendly controls, and leaderboard/history tables that reflow into readable cards (S-08 / FR-025). The desktop layout and all behavior stay unchanged — presentation-only, Tailwind-only.

## Starting Point

9 rendered routes share one layout and two shells (a `bg-cosmic` centered card for auth/dashboard; a `main.mx-auto.max-w-3xl.p-6` for the rest). There are **zero responsive breakpoint prefixes in app code today**, so this is additive mobile-first styling. The 4 raw tables share one class shell with no scroll wrapper, and an existing list-card idiom (`PredictionList`) is the model for reflow. A Vitest suite exists but runs on happy-dom (no layout engine); there is no e2e.

## Desired End State

At 360px every page is overflow-free and tap-friendly; the 4 tables become inline-labeled stacked cards on mobile and revert to today's tables from `sm:` (640px) up. The FR-014 "Locked" cue stays attached to its match, history values are unambiguous in card form, and desktop is pixel-equivalent to today. Verified by a manual checklist walk of all 9 routes at 360px.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Table behavior on mobile | Reflow to stacked labeled cards; tables at `sm:`+ | Zero side-scroll and reuses an idiom already in the codebase | Plan |
| Breakpoint floor / split | Design for ~360px; desktop returns at Tailwind `sm:` (640px) | Stock breakpoints, one clean mobile/desktop split, covers common phones | Plan |
| Tap-target scope | Page-level only; keep shadcn defaults, no `ui/` edits | Respects AGENTS.md "don't hand-author `ui/`" and stays presentation-only | Plan |
| Dashboard nav | Stack links full-width vertically on mobile; row at `sm:` | Clearly tappable, no overflow, mirrors the auth card | Plan |
| Card labeling | Every datum carries an inline `label: value` | Keeps FR-014/FR-021 values unambiguous without column headers | Plan |
| Verification | Manual checklist at 360px (no e2e infra) | Keeps S-08 presentation-only; defers browser e2e to the in-flight `testing-scoring` effort | Plan |

## Scope

**In scope:** responsive restyle of all 9 pages; 4 tables → mobile cards; dashboard nav stacking; form/control overflow + tap-target fixes at call sites.

**Out of scope:** any behavior/data/RLS/routing change; new dependencies; e2e/Playwright infra (manual checklist instead); editing shadcn `ui/` primitives; global tap-target uplift; native/PWA; dark mode.

## Architecture / Approach

Mobile-first base classes target ~360px; the current layout is re-applied under `sm:`. Tables render **two representations from the same data** — a mobile card list (`sm:hidden`) and the existing `<table>` (`hidden sm:table`) — so desktop is byte-for-byte unchanged. `.astro` pages keep plain inline `class` strings; `.tsx` components use `cn()`. Verification is a manual checklist walked at a 360px viewport across all 9 routes (no automated layout gate).

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Responsive shell & navigation | Mobile padding, dashboard card + nav stacking, auth card | Establishing the `sm:` convention consistently |
| 2. Tables → responsive cards | 4 tables reflow to labeled cards; desktop tables intact | Keeping desktop tables unchanged while adding the card variant |
| 3. Forms & interactive controls | Overflow + tap-target fixes; lock cue stays with its match; full manual checklist | FR-014 lock cue drifting from its match on reflow |

**Prerequisites:** the dev server (`npm run dev`); a browser with a 360px devtools viewport for manual verification.
**Estimated effort:** ~2–3 sessions across 3 phases (Phase 2 is the bulk).

## Open Risks & Assumptions

- **No automated layout regression guard** — verification is a manual checklist, so a future change could reintroduce horizontal overflow without anything catching it. Browser e2e is intentionally deferred to the in-flight `testing-scoring` effort to avoid duplicate scaffolding.
- Assumes the dual table+cards approach is acceptable markup duplication (chosen over CSS-morphing one DOM for desktop safety).
- Assumes ~360px floor is the agreed target; 320px-class devices get a denser but still overflow-free fit.
- Manual verification depends on discipline — the per-page 360px checklist in the plan's Testing Strategy must actually be walked for every route, including the data-heavy tables with realistic (long) content.

## Success Criteria (Summary)

- Every page is overflow-free and comfortably usable at 360px; desktop (≥640px) is unchanged.
- Leaderboard/history/participants tables read clearly as labeled cards on mobile; FR-014 lock and FR-021 history cues stay unambiguous.
- `npm run lint`, `npm run test`, `npm run build` pass; the manual 360px checklist is walked across all 9 routes with no horizontal overflow.
