<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Tournament & Matches (S-02)

- **Plan**: context/changes/tournament-and-matches/plan.md
- **Scope**: All 4 phases (full plan)
- **Date**: 2026-06-02
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 6 warnings, 2 observations

Verified live: `npm run lint` → 0 errors (3 pre-existing `no-console` warnings).
`npm test` → 28 passed, 5 skipped (the live-DB RLS integration test self-skips
with no DB configured, as designed). Defense-in-depth (in-handler admin check +
RLS) holds; `bulkAdd` is one atomic insert; the kickoff-lock zero-row guard is
correct.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

## Findings

### F1 — Match kickoff conversion trusts client timeZone, never bound to the tournament's DB zone

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/lib/schemas/match.ts:22,36 · src/actions/index.ts:80-88,101-108
- **Detail**: Every match payload carries its own `timeZone`, and `toMatch()` converts the wall-clock kickoff to UTC using that client-supplied value. The Action handlers never load `tournaments.time_zone` to cross-check it. Since `/_actions/*` is a public endpoint, a crafted payload (or a UI bug passing a stale zone) stores a UTC instant inconsistent with the zone the admin UI renders against — silent kickoff drift that S-03's blindness lock and S-04's scoring inherit. Not an auth bypass (RLS still limits writes to admins), but a data-integrity hole on the slice's most safety-critical value.
- **Fix**: In each match handler, load the tournament row and use its stored `time_zone` for the conversion (ignore the client `timeZone`), or reject when `input.timeZone !== tournament.time_zone`.
  - Strength: Makes the DB the single source of truth for the zone; the conversion can no longer be steered by the caller.
  - Tradeoff: One extra read per match write (negligible at this scale).
  - Confidence: HIGH — handlers already call `requireTournamentId`; reuse that read to also pull `time_zone`.
  - Blind spot: None significant.
- **Decision**: FIXED — `requireTournament` + `assertTournamentZone` in src/actions/index.ts bind add/bulkAdd/update to the DB zone.

### F2 — `timeZone` accepted as any non-empty string; invalid IANA → 500

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/lib/schemas/tournament.ts:11 · src/lib/schemas/match.ts:22
- **Detail**: Both schemas validate `timeZone` as `z.string().trim().min(1)`. The plan contract said "IANA string". A garbage zone (e.g. "Not/AZone") persists, then `localToUtc` (src/lib/time.ts) yields an Invalid Date (@date-fns/tz returns Invalid Date rather than throwing), and the downstream `.toISOString()` in the Action throws a RangeError → an unhandled 500 rather than a clean field error.
- **Fix**: Add a `.refine()` validating the zone via `Intl.DateTimeFormat(undefined, { timeZone }).resolvedOptions()` (throws on invalid) to both schemas, so a bad zone is a clean per-field validation error at the boundary.
- **Decision**: FIXED — added `isValidTimeZone` to src/lib/time.ts; both schemas now `.refine(isValidTimeZone)`.

### F3 — MatchForm submit handler isn't awaited; isSubmitting/double-submit unreliable

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/components/admin/MatchForm.tsx:154
- **Detail**: `form.handleSubmit(() => submit())` fires `submit()` without returning/awaiting its promise, so react-hook-form can't track the submission lifecycle — `formState.isSubmitting` may reset early and a double-submit is possible. TournamentForm passes the async handler correctly (`handleSubmit(onSubmit)`), so this is an inconsistency within the same slice.
- **Fix**: `form.handleSubmit(async () => { await submit(); })` to match TournamentForm's pattern.
- **Decision**: FIXED — handler now awaits submit() in src/components/admin/MatchForm.tsx.

### F4 — Admin page swallows query errors, renders failures as "empty"

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/pages/admin/index.astro:20,27-30
- **Detail**: Both the tournament and matches queries destructure only `{ data }`, ignoring `{ error }`. A transient DB/RLS failure renders as "no tournament yet" / an empty match list with no signal — the admin could be misled into re-creating the tournament.
- **Fix**: Capture `{ error }` on both queries; log server-side and render an error state (or throw a 500) instead of silently falling through to the empty UI.
- **Decision**: FIXED — both queries now capture `error`, log, and return a 500 Response in src/pages/admin/index.astro.

### F5 — matches.update reports "already kicked off" for any zero-row update

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/actions/index.ts:123-145
- **Detail**: The zero-row guard (`data.length === 0 → FORBIDDEN "kicked off"`) correctly implements the race-proof kickoff lock, but it also fires for an unknown/deleted UUID — surfacing a misleading "already kicked off" message and obscuring real bugs. The pre-check at line 123-128 already reads the row, so the two cases are separable.
- **Fix**: If the pre-check `current` is null → throw `NOT_FOUND`. Keep the post-update zero-row case as the race-proof `FORBIDDEN`/kicked-off.
- **Decision**: FIXED — pre-check now throws NOT_FOUND for an unknown id; zero-row post-update stays the kickoff lock.

### F6 — Raw Supabase error.message forwarded to the client

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/actions/index.ts:43,69,92,110,141
- **Detail**: Every `INTERNAL_SERVER_ERROR` passes the raw `error.message` straight to the island, which can leak table/column/constraint names. The surface is admin-only, so the blast radius is small, but it's a cheap hardening win.
- **Fix**: Return a stable generic message to the client; log the full `error` server-side only.
- **Decision**: FIXED — added `internalError()` helper; all DB errors log server-side and return a generic message.

### F7 — Benign extras outside the plan

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: eslint.config.js · supabase/config.toml · src/components/ui/label.tsx · src/middleware.ts
- **Detail**: Not in the plan but all supporting & benign: `eslint.config.js` ignores generated/shadcn files; `supabase/config.toml` keeps the email provider on for local sign-in + the RLS test; `label.tsx` is a shadcn dependency of `form.tsx`; and `middleware.ts` gained a `SECURITY_HEADERS` loop (an F-01 hardening carry-over, not S-02).
- **Fix**: None needed — note them so they're not mistaken for scope creep.
- **Decision**: ACCEPTED-AS-RULE: Unplanned-but-benign support files in a feature diff (lessons.md)

### F8 — Documented intent-preserving drifts

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/lib/bulk-parse.ts · src/components/admin/MatchForm.tsx · src/components/admin/MatchList.tsx
- **Detail**: Three deviations, all sound: bulk-parse splits lines then runs Papa per-line (because the kickoff field contains a space — whole-text Papa would mis-parse; documented in Progress 4.8); MatchForm uses a non-transforming `matchFormSchema` instead of the plan's z.input/z.output split (server re-validates with matchInputSchema — equivalent); kickoff display is done server-side in index.astro via `formatInZone` rather than in MatchList via `utcToZone` (same result).
- **Fix**: None — equivalent outcomes; worth recording so the plan and code don't read as contradictory.
- **Decision**: ACKNOWLEDGED — benign intent-preserving drifts, no action.
