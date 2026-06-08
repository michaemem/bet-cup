---
date: 2026-06-08T11:20:00+02:00
researcher: mimazu
git_commit: 29538eaa48f0061c63874a58d178d849ee091e19
branch: feature/S-08_mobile-responsive-ui
repository: braveai-prj
topic: "Mobile-responsive UI restyle across all pages (S-08 / FR-025)"
tags: [research, codebase, mobile, responsive, tailwind, layout, tables, forms, blindness, kickoff-lock]
status: complete
last_updated: 2026-06-08
last_updated_by: mimazu
---

# Research: Mobile-responsive UI restyle across all pages (S-08 / FR-025)

**Date**: 2026-06-08T11:20:00+02:00
**Researcher**: mimazu
**Git Commit**: 29538eaa48f0061c63874a58d178d849ee091e19
**Branch**: feature/S-08_mobile-responsive-ui
**Repository**: braveai-prj

## Research Question

What is the current state of every user-facing page and component in BetCup, so we can plan a **presentation-only, Tailwind-only** responsive (mobile) restyle (S-08 / FR-025)? Specifically: which pages exist, how they are laid out today, where horizontal overflow and small tap-targets occur on a ~360px phone, how tables/forms are structured, what Tailwind/shadcn conventions are in place, and — critically — how the FR-014 kickoff-lock and FR-015 blindness cues are communicated (so a compact layout never leaks a hidden prediction or obscures lock state).

## Summary

The app is much smaller and more uniform than the roadmap's page list implies, which makes S-08 a tractable, mechanical restyle rather than a redesign:

- **9 rendered UI routes** (+ a redirect-only `/`). The roadmap's "auth (signup/confirm-email)" pages **do not exist** — self-signup was removed in F-01; only `/auth/signin` exists.
- **One shared layout** (`src/layouts/Layout.astro`) with **no width/padding/breakpoints** of its own. Two repeating page shells: (A) a `bg-cosmic` full-viewport centered card (auth + dashboard) and (B) a content `<main class="mx-auto max-w-3xl … p-6">` (everything else).
- **Zero responsive breakpoint prefixes** (`sm:`/`md:`/`lg:`) anywhere in app pages or components. The only `sm:`/`md:` usages live **inside shadcn primitives** (`input.tsx`, `calendar.tsx`, `alert-dialog.tsx`). So responsive styling is essentially greenfield-within-an-existing-design.
- **4 raw `<table>` elements**, all with the identical `class="w-full text-left text-sm"` shell and **no `overflow-x` wrapper, no `min-w`, no scroll container** — these are the primary overflow targets: leaderboard (4 cols), own history (5 cols), others' history (5 cols), admin participants (3 cols). **No shadcn `table.tsx` primitive is installed.**
- **3 list/card patterns already exist** (`PredictionList`, `MatchList`, `BulkPasteImport` preview) — bordered divided `<ul>` rows — these are the existing reflow idiom to mirror when converting tables to stacked cards on mobile.
- **Overflow hotspots:** the four tables; the dashboard nav link rows (`flex gap-3`, no wrap, 4–6 links); the bulk-paste preview rows (fixed `w-36 + w-36 + w-44` + status text ≈ 480px); and the admin `MatchForm` kickoff row (`w-44 + w-32` ≈ exact 312px fit).
- **Tap-target gaps:** shadcn defaults are `h-9` (36px) for `Button`/`Input` and `h-8` (32px) for `size="sm"` buttons (Edit/Cancel/Delete); calendar day cells ≈ 32px; the password-visibility toggle is a ~16px icon with no padded hit area. All below the 44px guideline.
- **Blindness/lock cues are mostly structural, not column-positional** — which is good for mobile safety. FR-015 blindness is enforced by **not fetching** others' pre-kickoff data (RLS + query scope), so there is no blur/mask UI that a layout could accidentally defeat. FR-014 lock is shown by **presence/absence of the edit form** plus a muted uppercase "Locked" badge in `PredictionList`. The one residual risk: the lock badge + score sit in the right column of a `justify-between` header and could visually separate from their match on wrap.
- **Tailwind 4** via `@tailwindcss/vite` (`^4.2.4`), tokens in `src/styles/global.css` (`@theme inline`, oklch shadcn palette, `bg-cosmic` utility). No custom breakpoints/container/font-scale — stock Tailwind breakpoints apply. `cn()` (`src/lib/utils.ts`) is mandated for class composition (AGENTS.md), but note **`.astro` pages compose classes as plain inline strings** (no `cn()` in Astro markup today).
- **CSP allows `style-src 'self' 'unsafe-inline'`** (`src/middleware.ts`) — Tailwind utilities and scoped styles are fine; no obstacle to the restyle.

## Detailed Findings

### Route & page inventory

9 rendered UI routes (+ redirect-only root). All import the single `src/layouts/Layout.astro`.

| Route | File | S-08 area |
|---|---|---|
| `/` | `src/pages/index.astro` | redirect-only (no UI) |
| `/auth/signin` | `src/pages/auth/signin.astro` | Auth (signin) |
| `/dashboard` | `src/pages/dashboard.astro` | Dashboard |
| `/predictions` | `src/pages/predictions/index.astro` | Predictions |
| `/leaderboard` | `src/pages/leaderboard/index.astro` | Leaderboard |
| `/history` | `src/pages/history/index.astro` | History (own) |
| `/history/:participantId` | `src/pages/history/[participantId].astro` | History (others) |
| `/settings` | `src/pages/settings/index.astro` | Settings |
| `/admin` | `src/pages/admin/index.astro` | Admin tournament/match |
| `/admin/participants` | `src/pages/admin/participants.astro` | Admin manage-participants |

**Gap vs roadmap:** no `signup` / `confirm-email` pages exist (removed in F-01; admin-created accounts only). S-08's page list should be read as "every page that exists," which is the 9 above.

### Shared layout & page shells

- `src/layouts/Layout.astro:13-40` — `<body>` has **no Tailwind classes**; global body styling is `@apply bg-background text-foreground` (`src/styles/global.css:121-123`); scoped reset `html, body { margin:0; width:100%; height:100% }` (`Layout.astro:42-48`). Viewport meta present: `<meta name="viewport" content="width=device-width" />` (`Layout.astro:17`).
- **No shared nav/header component exists.** Navigation is page-local: dashboard renders horizontal `<a>` link rows; subpages render a single "Back to …" link in their `<header>`.
- **Shell A — cosmic centered card** (auth + dashboard): outer `bg-cosmic flex min-h-screen items-center justify-center p-4`, inner glass card `rounded-2xl border border-white/10 bg-white/10 … p-8 … backdrop-blur-xl` (`auth/signin.astro:9-10`, `dashboard.astro:8-9`). **Dashboard's inner card has no `max-w-*`/`w-full`** — width follows content.
- **Shell B — content main** (all other pages): `main class="mx-auto max-w-3xl space-y-* p-6"` (`predictions/index.astro:72`, `leaderboard/index.astro:44`, `history/index.astro:45`, `history/[participantId].astro:83`, `settings/index.astro:13`, `admin/index.astro:76`, `admin/participants.astro:43`). At 360px, usable content width ≈ `360 − 48` = **~312px**.

### Tables (primary overflow targets)

All four share `<table class="w-full text-left text-sm">` with no wrapper div, no `overflow-x-auto`, no `min-w`, no `whitespace-nowrap` on cells. **No `src/components/ui/table.tsx` exists.**

| Table | File:line | Cols | Columns |
|---|---|---|---|
| Leaderboard (FR-020) | `src/pages/leaderboard/index.astro:64-87` | 4 | `#` (`w-12`), Participant (link), Points, Exact |
| Own history (FR-021) | `src/pages/history/index.astro:63-94` | 5 | Match, Kickoff, Your prediction, Result, Points (+ total `tfoot`) |
| Others' history (FR-021b) | `src/pages/history/[participantId].astro:103-134` | 5 | Match, Kickoff, Prediction, Result, Points (+ total `tfoot`) |
| Admin participants | `src/pages/admin/participants.astro:57-78` | 3 | Name, Username (`font-mono`), Actions (delete button) |

Numeric cells use `tabular-nums`; right-aligned via `text-right`. The 5-column history tables are the highest width pressure.

### List/card reflow patterns already in the codebase

These bordered divided `<ul>` lists are the existing mobile-friendly idiom to mirror when stacking tables:

- `PredictionList` — `ul.divide-border divide-y rounded-md border` → `li.space-y-3 p-3` → header `div.flex items-center justify-between gap-4` (`src/components/predictions/PredictionList.tsx:45-48`).
- `MatchList` — same list shell; header `flex items-center justify-between gap-4`, no `flex-wrap` (`src/components/admin/MatchList.tsx:39-48`).
- `BulkPasteImport` preview — `ul.space-y-2` → `li.flex flex-wrap items-center gap-2 …` with fixed-width inputs (`src/components/admin/BulkPasteImport.tsx:100`).

### Forms & interactive islands

All islands hydrate with **`client:load` only** (no `client:visible`/`client:idle`). Inventory with mounts: `SignInForm` (`auth/signin.astro:16`), `DisplayNameForm` + `ChangePasswordForm` (`settings/index.astro:27,35`), `TournamentForm` / `MatchForm` / `BulkPasteImport` / `MatchList` (`admin/index.astro:87,95,100,105`), `DeleteParticipantButton` + `ParticipantForm` (`admin/participants.astro:73,85`), `PredictionList`→`PredictionForm` (`predictions/index.astro:85`). Nested (not separately hydrated): `PredictionForm`, `ResultForm`, `KickoffField`.

Sizing notes:
- Score inputs `w-20` (PredictionForm/ResultForm) inside `flex flex-wrap items-end gap-3` — safe at 360px.
- `MatchForm` home/away `w-40` each (332px → wraps via `flex-wrap`); kickoff row `w-44` date button + `w-32` time input ≈ **312px exact** (`src/components/admin/MatchForm.tsx:160,168,181,69-97`).
- `BulkPasteImport` preview row: `w-36 + w-36 + w-44` + status text ≈ **480px** — **overflows even with `flex-wrap`** (`src/components/admin/BulkPasteImport.tsx:101-130`). Textarea is `w-full min-h-28` (safe).
- Settings, tournament, participant-create forms use full-width default inputs — safe.
- Sign-in uses custom glass inputs (`FormField.tsx:5-6`, `w-full … px-3 py-2 pl-10`), full-width inside `max-w-sm` card — safe.

### shadcn primitive sizing (drives global tap-targets)

Installed under `src/components/ui/`: `alert-dialog`, `button`, `calendar`, `form`, `input`, `label`, `popover`, plus a custom `LibBadge.astro`. **Not installed:** `table`, `select`, `dialog`, `textarea`, `sheet`, `dropdown-menu`.

- `Button` (`button.tsx:21-26`): default `h-9` (36px), `sm` `h-8` (32px), `lg` `h-10`, `icon` `size-9`. Base has `whitespace-nowrap`.
- `Input` (`input.tsx:10-15`): `h-9 w-full min-w-0 … text-base md:text-sm` (36px, full width).
- `AlertDialogContent` (`alert-dialog.tsx:45-46`): `w-full max-w-[calc(100%-2rem)] … sm:max-w-lg` — **already mobile-safe**; footer `flex-col-reverse … sm:flex-row` stacks on mobile.
- `PopoverContent` (`popover.tsx:26-28`): fixed `w-72` (288px) by default; the kickoff popover overrides to `w-auto … p-0`.
- `Calendar` (`calendar.tsx:27`): `--cell-size: --spacing(8)` ≈ 32px day cells.

### Tailwind 4 / shadcn / cn() conventions

- Tailwind `^4.2.4` via `@tailwindcss/vite` (`package.json:36,51`, `astro.config.mjs:6,14`); global entry `src/styles/global.css` imported in `Layout.astro:2`. **No `tailwind.config`** (`components.json:7` `"config": ""`).
- `global.css`: `@import "tailwindcss"` + `tw-animate-css`; `@custom-variant dark`; oklch token `:root`/`.dark`; `@theme inline` color/radius bridge (`global.css:75-111`); custom `@utility bg-cosmic` (`global.css:113-115`). **No custom breakpoints, container, or font scale** → stock Tailwind breakpoints (sm 640 / md 768 / lg 1024 / xl 1280).
- `cn()` (`src/lib/utils.ts:1-6`) = `twMerge(clsx(...))`; AGENTS.md mandates it for class composition. Caveat: **`.astro` pages use plain inline `class="…"` strings** (no `cn()`), while React components use `cn()` — keep that split when restyling.
- shadcn: `new-york`, base color `neutral`, CSS variables true (`components.json`). Per AGENTS.md, new primitives must be added via `npx shadcn@latest add <name>` (relevant if a `table` primitive is chosen during planning).

### FR-014 kickoff-lock & FR-015 blindness cues (mobile-safety critical)

- **FR-015 blindness is data-level, not visual.** Others' pre-kickoff predictions are **never in the payload**: predictions query is `.eq("predictor_id", userId)` (`predictions/index.astro:41-47`); cross-participant history lists only revealed/post-kickoff rows (`src/lib/history.ts:137-143`). There is **no blur/mask UI** a compact layout could defeat — the risk surface is much smaller than the roadmap's worst case implies.
- **FR-014 lock cue (predictions):** locked = render `LockedScore` (read-only `tabular-nums` score + muted uppercase `Locked` badge) and **omit `PredictionForm`**; open = render the form, no badge (`PredictionList.tsx:21-28,48-64`). The state is communicated **structurally** (form present vs absent), which survives reflow. Residual risk: the badge/score live in the right column of a `flex justify-between gap-4` header — on a narrow wrap they could drift from the match label; planning should keep the lock cue adjacent to its match in the stacked layout.
- **Supporting cues:** copy "Only you can see your predictions until kickoff" (`predictions/index.astro:75-79`); "Revealed predictions … for matches that have kicked off" (`history/[participantId].astro:88-90`). Admin `MatchList` shows `Awaiting result`/`Result entered` badges (`MatchList.tsx:49-52`) and `BulkPasteImport` shows past-kickoff amber text (`BulkPasteImport.tsx:126-127`).
- History/leaderboard meaning is tied to **column headers** (no per-row badges) — when tables stack into cards on mobile, each datum must carry its own label so prediction/result/points don't become ambiguous.

### CSP / inline styles

`src/middleware.ts:29-37` sets `Content-Security-Policy` with `style-src 'self' 'unsafe-inline'` — Tailwind utility classes and scoped/inline styles are permitted across all SSR responses. No constraint on the restyle.

## Code References

- `src/layouts/Layout.astro:13-48` — single shared layout; bare `<body>`, viewport meta, scoped html/body reset; no width/padding/breakpoints.
- `src/styles/global.css:1-124` — Tailwind 4 import, oklch tokens, `@theme inline` bridge, `bg-cosmic` utility, base body styling. No custom breakpoints.
- `src/lib/utils.ts:1-6` — `cn()` helper.
- `components.json:1-21` — shadcn new-york / neutral / CSS variables config.
- `src/pages/auth/signin.astro:9-10` / `src/pages/dashboard.astro:8-9` — cosmic centered-card shell (dashboard card has no max-width).
- `src/pages/dashboard.astro:17-58` — non-wrapping nav link rows (overflow risk).
- `src/pages/leaderboard/index.astro:64-87` — 4-col leaderboard table, no scroll wrapper.
- `src/pages/history/index.astro:63-94` / `src/pages/history/[participantId].astro:103-134` — 5-col history tables + total footer.
- `src/pages/admin/participants.astro:57-78` — 3-col participants table.
- `src/components/predictions/PredictionList.tsx:21-64` — lock badge + form-presence lock cue; list-card pattern.
- `src/components/predictions/PredictionForm.tsx:57-109` / `src/components/admin/ResultForm.tsx:57-109` — `w-20` score inputs in `flex flex-wrap`.
- `src/components/admin/MatchForm.tsx:69-104,160-186` — kickoff row (`w-44`+`w-32`) and home/away `w-40` row.
- `src/components/admin/BulkPasteImport.tsx:85-130` — full-width textarea + fixed-width preview rows (overflow).
- `src/components/admin/MatchList.tsx:39-100` — list-card pattern, `sm` (h-8) Edit/Cancel buttons, status badges.
- `src/components/ui/button.tsx:21-26` / `src/components/ui/input.tsx:10-15` — global tap-target sizing (h-9 / h-8).
- `src/components/ui/alert-dialog.tsx:45-73` / `src/components/ui/popover.tsx:26-28` — modal/popover widths.
- `src/components/auth/PasswordToggle.tsx:10-16` — ~16px icon toggle, no padded hit area.
- `src/middleware.ts:29-37` — CSP allows inline styles.
- `src/lib/history.ts:137-143` — history listing rule enforcing FR-015/FR-021b reveal boundary.

## Architecture Insights

- **Uniformity is the lever.** Two page shells + one table class + one list-card class means S-08 can be executed largely by (a) wrapping/reflowing the shared table pattern, (b) wrapping the dashboard nav rows, and (c) sizing a handful of fixed-width form rows — then verified per page. A shared responsive table-or-cards approach applied once propagates to all four tables.
- **Responsive styling is additive, not corrective.** Because there are zero `sm:`/`md:` prefixes in app code, the restyle adds mobile-first base styles + breakpoint overrides without unwinding an existing responsive system. Desktop (`max-w-3xl`) is preserved by keeping current classes as the `md:`/`lg:` tier.
- **Two class-composition idioms coexist:** plain inline strings in `.astro`, `cn()` in `.tsx`. Honor both; don't introduce `cn()` into Astro markup.
- **Blindness safety is mostly already guaranteed server-side.** The honest residual UI risk is narrow: keeping the FR-014 lock cue unambiguous and adjacent to its match in stacked layouts, and labeling per-datum values when tables become cards. This matches the roadmap's stated guardrail.
- **No `table.tsx` primitive** — planning decides between a horizontal-scroll wrapper (`overflow-x-auto`) and a stacked-card reflow (mirroring `PredictionList`). The codebase already has the card idiom, favoring reflow for the narrow leaderboard/history tables; scroll may suit the admin tables.

## Historical Context (from prior changes)

- `context/foundation/roadmap.md:176-188` (S-08) — defines the outcome, the "presentation-only, Tailwind-only" constraint, the unknowns now answerable (table strategy; breakpoint floor ~360px), and the blindness/lock guardrail.
- `context/foundation/prd.md:122-125` (FR-025) — the testable requirement: no horizontal overflow, tap-friendly controls, reflow/scroll tables, desktop + behavior unchanged.
- `context/foundation/lessons.md:12-17` — "Isolation criteria should target production reads, not literal grep across src/." Not directly about styling, but relevant if any S-08 success criterion greps `src/`: exclude test files / assert counts rather than raw substring matches.
- `context/foundation/lessons.md:5-10` — benign unplanned support files (e.g. a shadcn primitive pulled transitively) read as scope creep at review; if S-08 adds a `table` primitive via the shadcn CLI, name it in the plan's "Changes Required."
- Prior changes that built these pages (now archived): `context/archive/2026-06-04-results-scoring-leaderboard/`, `context/archive/2026-06-05-participant-match-history/`, `context/archive/2026-06-01-tournament-and-matches/`, `context/archive/2026-06-03-admin-creates-participants/`, `context/archive/2026-05-28-identity-boundary/`.

## Related Research

No prior `research.md` exists for a UI/styling concern. Adjacent in-flight changes: `context/changes/testing-scoring/`, `context/changes/deployment/`, `context/changes/bootstrap-verification/` (none overlap S-08's presentation scope).

## Open Questions

1. **Table strategy per table** (roadmap unknown, owner `/10x-plan`): stacked-card reflow (mirror `PredictionList`) vs. horizontal-scroll-in-container (`overflow-x-auto`). Leaning reflow for the narrow 4/5-col leaderboard/history tables; scroll may be acceptable for admin participants. Decide whether to add a shadcn `table.tsx` primitive or restyle the existing raw `<table>`s in place.
2. **Breakpoint floor** (roadmap unknown, owner user): confirm ~360px portrait as the target and whether any specific device in the group needs explicit verification.
3. **Dashboard card width** — the inner card has no `max-w`/`w-full`; decide the mobile width behavior (full-width with padding vs. capped).
4. **Tap-target uplift scope** — whether to bump shadcn `sm` buttons / calendar cells / the password toggle to ≥44px globally (touches `ui/` primitives, which AGENTS.md says to manage via the shadcn CLI, not hand-edit) or only at the page level. This is the main place the "presentation-only" boundary could blur into primitive edits.
5. **Stacked-table labeling** — when tables collapse to cards, each value (prediction/result/points) needs its own visible label since column headers disappear; confirm the labeling approach keeps the FR-014/FR-015 cues unambiguous.
6. **Verification method** — there is no test suite yet (AGENTS.md). Decide how mobile rendering / no-horizontal-overflow is verified (manual at 360px, a Playwright viewport check, etc.).
