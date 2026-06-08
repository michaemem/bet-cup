# Mobile-Responsive UI Across All Pages Implementation Plan

## Overview

Make every BetCup page usable on a phone (~360px): no horizontal overflow, tap-friendly controls, and leaderboard/history tables that reflow into readable cards. The desktop layout and all behavior stay unchanged — this is a presentation-only, Tailwind-only restyle (S-08 / FR-025). Responsive styling is added mobile-first, with the current desktop layout reappearing at the Tailwind `sm:` (640px) breakpoint.

## Current State Analysis

From `context/changes/mobile-responsive-ui/research.md` (the codebase baseline):

- **9 rendered routes** (+ a redirect-only `/`), all using the single `src/layouts/Layout.astro`. The roadmap's `signup`/`confirm-email` pages do not exist (removed in F-01).
- **Two page shells:** (A) `bg-cosmic` full-viewport centered card (auth + dashboard); (B) content `<main class="mx-auto max-w-3xl … p-6">` (everything else). At 360px, shell B's usable width is ~312px.
- **Zero responsive breakpoint prefixes** in app code today — `sm:`/`md:`/`lg:` appear only inside shadcn primitives. So the restyle is additive, not corrective.
- **4 raw `<table>`s** share `class="w-full text-left text-sm"` with no scroll wrapper, no `min-w`: leaderboard (4 cols), own history (5 cols), others' history (5 cols), admin participants (3 cols). No `ui/table.tsx` primitive exists.
- **Existing list-card idiom** to mirror: `PredictionList` / `MatchList` (`ul.divide-border divide-y rounded-md border` → `li.p-3` → header `flex items-center justify-between gap-4`).
- **Overflow hotspots:** the 4 tables; dashboard nav rows (`flex gap-3`, no wrap, 4–6 links); `BulkPasteImport` preview rows (`w-36 + w-36 + w-44` + status text ≈ 480px); `MatchForm` kickoff row (`w-44 + w-32` ≈ 312px exact).
- **Tap-target gaps:** shadcn `Button`/`Input` default `h-9` (36px), `size="sm"` `h-8` (32px), calendar cells ≈ 32px, password toggle ≈ 16px icon with no padded hit area.
- **FR-015 blindness is data-level** (others' pre-kickoff predictions are never fetched), so no blur/mask UI can be defeated by layout. **FR-014 lock** is structural (form present vs. a muted "Locked" badge in `PredictionList`); the only residual risk is the badge drifting from its match on wrap.
- **Tooling:** Tailwind 4 via `@tailwindcss/vite`; tokens in `src/styles/global.css` (no custom breakpoints → stock Tailwind `sm` 640 / `md` 768 / `lg` 1024). `cn()` (`src/lib/utils.ts`) mandated for class composition in `.tsx`; `.astro` pages use plain inline `class` strings. shadcn `new-york`, managed via the CLI (do not hand-author `src/components/ui/`). CSP allows inline styles.
- **Tests:** a real Vitest suite exists (15 files, unit + RLS-integration via `pg`) running on **happy-dom** (no layout engine). No Playwright/e2e. Tests are **local-only** (RLS needs Docker/Supabase); CI runs lint + `check:wrangler` + build only. Local admin is seeded from `ADMIN_EMAIL`/`ADMIN_PASSWORD` via `scripts/seed-template.mjs` → `supabase/seed.sql`.

## Desired End State

Every one of the 9 routes renders at 360px with no horizontal overflow, readable typography, and tap-friendly controls; the 4 tables present as inline-labeled stacked cards on mobile and as the existing tables from `sm:` upward. The FR-014 lock cue stays visually attached to its match, and FR-021/FR-021b history values are unambiguous in card form. Desktop (≥ `sm:`) is pixel-equivalent to today.

Verification: `npm run lint`, `npm run test`, and `npm run build` pass; a manual walk of each page at 360px against the checklist in Testing Strategy confirms no horizontal overflow and tap-friendliness.

### Key Discoveries:

- Existing card idiom to mirror for table reflow: `src/components/predictions/PredictionList.tsx:45-48`.
- All 4 tables share one class shell — a single card/label approach generalizes: `src/pages/leaderboard/index.astro:64-87`, `src/pages/history/index.astro:63-94`, `src/pages/history/[participantId].astro:103-134`, `src/pages/admin/participants.astro:57-78`.
- Lock cue to keep adjacent on reflow: `LockedScore` in `src/components/predictions/PredictionList.tsx:21-28,48-64`.
- shadcn primitives must not be hand-edited (AGENTS.md); tap-target fixes happen at call sites.

## What We're NOT Doing

- No behavior, data, routing, API, or RLS changes. No copy changes except adding per-field labels inside reflowed cards.
- No new dependencies (Tailwind-only styling).
- No e2e/Playwright infrastructure — verification is a manual checklist at 360px (no test suite picks up layout regressions; happy-dom can't, and standing up a browser e2e harness is deferred to the in-flight `testing-scoring` effort to avoid duplicate scaffolding).
- No hand-authoring or resizing of `src/components/ui/` shadcn primitives; no global tap-target uplift of primitives.
- No `signup`/`confirm-email` work (those pages don't exist).
- No native-app/PWA work (parked in the PRD).
- No dark-mode or visual redesign.
- No conversion of the `MatchList`/`PredictionList` lists into tables or vice versa beyond responsive header reflow.

## Implementation Approach

Mobile-first: base (unprefixed) classes target ~360px; the current layout is re-applied at `sm:`. Concretely, where a desktop rule exists today (e.g. a horizontal flex row, a `<table>`), the mobile base becomes the stacked/compact form and the existing rule is re-expressed under `sm:`. This keeps desktop visually identical (everything ≥640px gets the `sm:` rules) while giving phones a dedicated layout.

For tables, render **both** a mobile card list (`sm:hidden`) and the existing table (`hidden sm:table`) from the same server data, rather than CSS-morphing one DOM. This keeps each representation simple and the desktop table byte-for-byte unchanged. Each mobile card carries inline `label: value` pairs so meaning survives without column headers.

Class composition honors the existing split: `.astro` pages use plain inline `class` strings; `.tsx` components use `cn()`.

**Tap-target bar (the testable threshold for "tap-friendly"):** primary and secondary interactive controls — links, submit buttons, the password toggle, and the secondary Edit/Cancel/Delete actions — target ≥44px effective hit area on mobile. The one documented exception is the shadcn `Calendar` day cells (~32px): enlarging them requires editing `src/components/ui/calendar.tsx`, which AGENTS.md forbids hand-editing, so they are accepted as-is (the kickoff date is also reachable by typing into the date field). All other below-bar controls are fixed at their call sites (no `ui/` primitive edits).

## Phase 1: Responsive shell & navigation

### Overview

Establish the mobile-first `sm:` convention and fix the app shell so every page has sane mobile padding and the dashboard/auth cards and navigation work at 360px.

### Changes Required:

#### 1. Content shell padding

**Files**: `src/pages/predictions/index.astro:72`, `src/pages/leaderboard/index.astro:44`, `src/pages/history/index.astro:45`, `src/pages/history/[participantId].astro:83`, `src/pages/settings/index.astro:13`, `src/pages/admin/index.astro:76`, `src/pages/admin/participants.astro:43`

**Intent**: Reduce the `main` horizontal padding on mobile so ~360px isn't eaten by `p-6` (48px), restoring `p-6` at `sm:`. Keep `mx-auto max-w-3xl`.

**Contract**: `class="mx-auto max-w-3xl space-y-* p-4 sm:p-6"` (preserve each page's existing `space-y-*`). No change to `max-w-3xl`.

#### 2. Dashboard card width + vertical nav stacking

**File**: `src/pages/dashboard.astro` (card `:9`, nav rows `:17,:45`, link buttons `:19-20`, sign-out `:61-68`)

**Intent**: Give the dashboard card a mobile width cap with full-width behavior, and stack the participant/admin nav link rows vertically full-width on mobile, returning to the horizontal row at `sm:`. Make each link/sign-out button full-width on mobile for a clear tap target.

**Contract**: card gains `w-full max-w-sm` (centered via existing flex); nav containers go `flex flex-col sm:flex-row` with full-width links on mobile (`block w-full text-center sm:inline-block sm:w-auto`). No link targets or counts change.

#### 3. Auth sign-in card check

**File**: `src/pages/auth/signin.astro:9-10`

**Intent**: Confirm the `max-w-sm` glass card and `p-4` outer already fit 360px; only adjust if the heading or inner `p-8` crowds — reduce inner padding on mobile if needed.

**Contract**: at most `p-8` → `p-6 sm:p-8` on the inner card. No structural change.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Unit tests pass: `npm run test`
- Production build succeeds: `npm run build`

#### Manual Verification:

- At 360px, `/dashboard` shows nav links as a full-width vertical stack with no horizontal overflow; at ≥640px the links are a horizontal row identical to today.
- `/auth/signin` card fits within 360px with comfortable padding.
- All shell-B pages have comfortable mobile padding and remain unchanged at desktop width.

**Implementation Note**: After automated verification passes, pause for human confirmation of the manual checks before Phase 2.

---

## Phase 2: Tables → responsive cards

### Overview

Convert the 4 tables to a dual representation: an inline-labeled stacked card list on mobile and the existing `<table>` from `sm:` upward, from the same server data.

### Changes Required:

#### 1. Leaderboard

**File**: `src/pages/leaderboard/index.astro:64-87`

**Intent**: Add a mobile card list (`sm:hidden`) where each participant renders rank, name (linked to history), points, and exact-score count as labeled fields; wrap the existing table as `hidden sm:table` so desktop is unchanged.

**Contract**: mobile list mirrors the `PredictionList` shell (`ul.divide-border divide-y rounded-md border` → `li.p-3`); each card shows the linked name plus `Points: N` and `Exact: N` labels and the rank. Table markup unchanged except a `hidden sm:table` visibility class on the table (or a `sm:` wrapper). Preserve `tabular-nums`.

#### 2. Own history

**File**: `src/pages/history/index.astro:63-94`

**Intent**: Mobile card per match with labeled `Your prediction`, `Result`, `Points`, plus the kickoff; keep the total. Desktop table unchanged.

**Contract**: each mobile card shows `{home} vs {away}`, kickoff, and `Your prediction: …` / `Result: …` / `Points: …` labeled values; the total renders as a labeled summary line on mobile and the existing `tfoot` on desktop. Em-dash for missing values preserved.

#### 3. Others' revealed history

**File**: `src/pages/history/[participantId].astro:103-134`

**Intent**: Same card treatment as own history, with the `Prediction` label (not "Your prediction"). Desktop table unchanged.

**Contract**: identical structure to Change 2 with the participant-facing label; preserves the FR-021b reveal semantics (data already filtered server-side in `src/lib/history.ts`).

#### 4. Admin participants

**File**: `src/pages/admin/participants.astro:57-78`

**Intent**: Mobile card per participant showing name and `Username: …` (keep `font-mono`) with the delete button as a full-width action; desktop table unchanged.

**Contract**: mobile card hosts the existing `DeleteParticipantButton` (full-width on mobile); table gets `hidden sm:table`. The `sr-only` Actions header is retained for the desktop table.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Unit tests pass: `npm run test`
- Production build succeeds: `npm run build`

#### Manual Verification:

- At 360px, each of the 4 tables renders as labeled cards with no horizontal overflow; every value is unambiguously labeled.
- At ≥640px, all 4 tables render exactly as before (columns, alignment, totals, links intact).
- Leaderboard name links still navigate to the correct history page from the mobile card.
- Others' history shows only revealed predictions (no behavior change).

**Implementation Note**: After automated verification passes, pause for human confirmation before Phase 3.

---

## Phase 3: Forms & interactive controls

### Overview

Make forms and interactive list rows tap-friendly and overflow-free at 360px, fixing sizing at call sites only (no `ui/` primitive edits), and keep the FR-014 lock cue attached to its match on reflow.

**Intentionally left unchanged:** `TournamentForm` (`/admin`) uses full-width default inputs and is already overflow-safe and tap-friendly at 360px (research §Forms), so it gets no changes — named here so its absence from the diff reads as verified, not missed.

### Changes Required:

#### 1. Predictions & match list header rows (keep lock cue adjacent)

**Files**: `src/components/predictions/PredictionList.tsx:48-55`, `src/components/admin/MatchList.tsx:42-48`

**Intent**: Allow the `justify-between` match header to stack on mobile so the team name and the lock/score (or status) cue don't crowd or visually separate; the cue stays directly under/with its match.

**Contract**: header `div` becomes `flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4`. `LockedScore` / status badge markup unchanged.

#### 2. Score entry forms

**Files**: `src/components/predictions/PredictionForm.tsx:57-109`, `src/components/admin/ResultForm.tsx:57-109`

**Intent**: Ensure the `w-20` score inputs + submit wrap cleanly and the submit is comfortably tappable on mobile.

**Contract**: keep `flex flex-wrap items-end gap-3`; make the submit `Button` full-width on mobile if it crowds (`w-full sm:w-auto`). Inputs stay `w-20`. Composed via `cn()`.

#### 3. MatchForm kickoff + team rows

**File**: `src/components/admin/MatchForm.tsx:69-104,160-186`

**Intent**: Prevent the kickoff row (`w-44` date + `w-32` time) and the two `w-40` team inputs from forcing overflow at 360px.

**Contract**: team/kickoff field wrappers go full-width and stack on mobile (`w-full sm:w-40` / `sm:w-44` / `sm:w-32`); kickoff container `flex flex-col gap-2 sm:flex-row`. Popover/calendar behavior unchanged.

#### 4. BulkPasteImport preview rows

**File**: `src/components/admin/BulkPasteImport.tsx:85-130`

**Intent**: The fixed-width preview inputs (`w-36 + w-36 + w-44` + status text ≈ 480px) overflow even with `flex-wrap`; make them stack/full-width on mobile.

**Contract**: preview row inputs become `w-full sm:w-36` / `sm:w-44`; row stays `flex flex-wrap … gap-2`; status text wraps. Textarea (`w-full min-h-28`) unchanged. Composed via `cn()`.

#### 5. ParticipantForm & credentials panel

**File**: `src/components/admin/ParticipantForm.tsx:64-128`

**Intent**: Ensure the credentials reveal panel `dl` rows (`w-20` label column) and the Copy/Create-another button row don't overflow on mobile.

**Contract**: button row `flex flex-col gap-2 sm:flex-row`; `dl` rows allowed to wrap. Create form already full-width — no change.

#### 6. Password-toggle hit area

**File**: `src/components/auth/PasswordToggle.tsx:10-16`

**Intent**: Enlarge the ~16px icon-only toggle's tap area without changing its appearance.

**Contract**: add padding/min hit-area to the button (e.g. `p-2 -m-2` so the visual position is unchanged) keeping the `size-4` icon. Composed via `cn()`.

#### 7. Settings forms check

**File**: `src/components/account/DisplayNameForm.tsx`, `src/components/account/ChangePasswordForm.tsx`

**Intent**: Confirm full-width inputs already fit 360px; make submit buttons full-width on mobile for consistency if desired.

**Contract**: optional `w-full sm:w-auto` on submit buttons. No structural change.

#### 8. Secondary action button tap-targets (call-site only)

**Files**: `src/components/admin/MatchList.tsx:54-74` (Cancel `:57`, Edit `:68`), `src/components/admin/DeleteParticipantButton.tsx:57` (Delete)

**Intent**: Raise the `size="sm"` (h-8 / 32px) secondary actions to the default h-9 so they meet the tap-target bar. The shadcn `Calendar` day cells (~32px) are the documented exception (see Implementation Approach) and are intentionally left unchanged.

**Contract**: drop `size="sm"` (fall back to the default `h-9` size) on the MatchList Edit/Cancel and the DeleteParticipantButton; keep each button's `variant`. No `src/components/ui/button.tsx` edit. Appearance otherwise unchanged.

### Success Criteria:

#### Automated Verification:

- Linting passes: `npm run lint`
- Unit tests pass: `npm run test`
- Production build succeeds: `npm run build`

#### Manual Verification:

- At 360px, `/predictions`, `/admin`, `/admin/participants`, `/settings` have no horizontal overflow; the bulk-paste preview and kickoff rows stack cleanly.
- The "Locked" cue (and admin status badge) stays directly with its match when the header stacks; an open match still shows the editable form and a locked one still shows the read-only score + badge.
- Submit buttons and the password toggle are comfortably tappable on a phone.
- Secondary actions (MatchList Edit/Cancel, participant Delete) meet the ≥44px tap-target bar; the Calendar day cells remain the documented ~32px exception.
- Desktop (≥640px) layout of every form is unchanged.
- The full manual checklist (Testing Strategy) has been walked across all 9 routes at 360px with no horizontal overflow anywhere.

**Implementation Note**: This is the final phase. After automated verification passes, complete the full manual checklist (Testing Strategy) at 360px across all 9 routes before considering the change done.

---

## Testing Strategy

### Unit Tests:

- No new Vitest unit tests — the change is presentation-only and Vitest runs on happy-dom (no layout). The existing suite must keep passing.

### Manual Verification (the primary gate for this change):

Verification is a manual checklist at 360px — there is no automated layout regression guard (happy-dom can't compute layout, and standing up a browser e2e harness is deferred to the in-flight `testing-scoring` effort). Run the steps below in browser devtools at a 360px-wide viewport.

### Manual Testing Steps (per page, at 360px in browser devtools):

1. No horizontal scrollbar / no content cut off at the right edge.
2. Tables (`/leaderboard`, `/history`, `/history/:id`, `/admin/participants`) render as labeled cards; every value is clearly labeled.
3. `/predictions`: open match shows the editable form; locked match shows the read-only score + "Locked" badge directly with its match.
4. `/admin`: add-match, kickoff picker, and bulk-paste preview rows stack without overflow.
5. `/dashboard`: nav links are a full-width vertical stack; sign-out is tappable.
6. Buttons, inputs, and the password toggle are comfortably tappable.
7. Switch to ≥640px and confirm every page matches the current desktop layout.

## Migration Notes

None — no data or schema changes. Rollback is a code revert (`npx wrangler rollback` if already deployed); no Supabase migration boundary is crossed.

## References

- Research: `context/changes/mobile-responsive-ui/research.md`
- Roadmap slice: `context/foundation/roadmap.md:176-188` (S-08)
- Requirement: `context/foundation/prd.md:122-125` (FR-025)
- Card idiom to mirror: `src/components/predictions/PredictionList.tsx:45-48`
- Lessons: `context/foundation/lessons.md` (flag unplanned support files; phrase any grep-based criteria against production reads)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Responsive shell & navigation

#### Automated

- [x] 1.1 Linting passes: `npm run lint` — cb14bde
- [x] 1.2 Unit tests pass: `npm run test` — cb14bde
- [x] 1.3 Production build succeeds: `npm run build` — cb14bde

#### Manual

- [x] 1.4 `/dashboard` nav stacks full-width on mobile; horizontal row at ≥640px; no overflow — cb14bde
- [x] 1.5 `/auth/signin` card fits 360px with comfortable padding — cb14bde
- [x] 1.6 All shell-B pages have comfortable mobile padding; unchanged at desktop width — cb14bde

### Phase 2: Tables → responsive cards

#### Automated

- [x] 2.1 Linting passes: `npm run lint`
- [x] 2.2 Unit tests pass: `npm run test`
- [x] 2.3 Production build succeeds: `npm run build`

#### Manual

- [x] 2.4 All 4 tables render as labeled cards at 360px with no overflow; values unambiguous
- [x] 2.5 All 4 tables render exactly as before at ≥640px (columns, alignment, totals, links)
- [x] 2.6 Leaderboard mobile card name link navigates to the correct history page
- [x] 2.7 Others' history still shows only revealed predictions

### Phase 3: Forms & interactive controls

#### Automated

- [ ] 3.1 Linting passes: `npm run lint`
- [ ] 3.2 Unit tests pass: `npm run test`
- [ ] 3.3 Production build succeeds: `npm run build`

#### Manual

- [ ] 3.4 `/predictions`, `/admin`, `/admin/participants`, `/settings` have no overflow at 360px; bulk-paste + kickoff rows stack
- [ ] 3.5 Lock cue / status badge stays with its match when the header stacks; open vs locked states correct
- [ ] 3.6 Submit buttons and password toggle are comfortably tappable
- [ ] 3.7 Secondary actions (MatchList Edit/Cancel, participant Delete) meet ≥44px bar; Calendar cells the documented exception
- [ ] 3.8 Desktop (≥640px) form layouts unchanged
- [ ] 3.9 Full manual checklist (Testing Strategy) walked across all 9 routes at 360px
