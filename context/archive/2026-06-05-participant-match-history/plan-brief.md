# Participant Match History (S-05) — Plan Brief

> Full plan: `context/changes/participant-match-history/plan.md`
> Research: `context/changes/participant-match-history/research.md`

## What & Why

Give participants a match-by-match history (FR-021): their prediction, the actual result once the admin enters it, and the points earned — before a result exists, only the prediction shows. Extend it so a participant can also view any **other** participant's **revealed (post-kickoff)** history (new FR-021b), opened by clicking a name on the leaderboard. This closes the loop on the scoring product: people can review how their picks scored and compare against others, without ever leaking a pre-kickoff prediction.

## Starting Point

S-04 already shipped the full data layer: `match_results`, the `score_prediction()` SQL rule, and the `prediction_scores` / `leaderboard` views (`security_invoker`, authenticated-granted). No app code reads `prediction_scores` yet. Predictions already enforce blindness via RLS (`predictor_id = auth.uid() OR match_is_kicked_off(...)`). There is no history page and no per-match points read in the app.

## Desired End State

A "My history" link on the dashboard opens `/history`: a table of the caller's matches (prediction, result, points) with a running total that equals their leaderboard total. Clicking a name on `/leaderboard` opens `/history/[participantId]`, showing that participant's kicked-off matches only — their revealed predictions, results, and points — never their future picks.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Cross-participant viewing | Own default + drill into others' revealed history | User goal; consistent with FR-016 reveal | Research |
| Data assembly | Merge matches+predictions+results in Astro frontmatter | Zero migration; mirrors `predictions/index.astro` | Plan |
| Points source | Read from `prediction_scores` view, never recompute in TS | Single SQL source of truth for FR-018 | Plan |
| Routing | `/history` + `/history/[participantId]` | Clean, shareable; shared loader | Plan |
| Other-participant rows | Kicked-off (revealed) matches only | Matches DB-enforced blindness boundary | Plan |
| Own-page listing | Only matches with your prediction OR a result | User decision; hide unpredicted future fixtures | Plan |
| UI | Raw HTML table, SSR, no island | Read-only; matches leaderboard precedent | Plan |
| PRD change | Add FR-021b; keep FR-021; update roadmap S-05 | Preserve traceability; additive | Plan |

## Scope

**In scope:** own history page, cross-participant revealed-history page, leaderboard name links, shared row-builder, FR-021b + roadmap update, blindness/consistency/row-logic tests.

**Out of scope:** any migration/new SQL object, recomputing FR-018 in TS, editing predictions/results from history, listing unpredicted future fixtures, real-time updates, `username` exposure, new shadcn dependency.

## Architecture / Approach

Pure read slice. A shared `src/lib/history.ts` runs four session-client (RLS) reads — `matches`, `predictions` (filtered by target id), `match_results`, `prediction_scores` (filtered by target id) — and a pure `buildHistoryRows` merges them into display rows + a running total (a match is listed iff the viewed participant has a prediction or a result exists; points come from `prediction_scores`). Two thin Astro pages (`/history`, `/history/[participantId]`) render the same raw table; the dynamic page resolves `display_name` and redirects self → `/history`. Blindness is enforced entirely by existing `predictions` RLS.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. PRD & roadmap | FR-021b + updated S-05 wording | Doc/behavior drift if listing rule mis-stated |
| 2. Own history page | `/history` + shared loader + dashboard link | Mis-mapping points (must read from view, not recompute) |
| 3. Cross-participant drill-in | `/history/[participantId]` + leaderboard links | Accidentally bypassing RLS / leaking pre-kickoff picks |
| 4. Tests | Blindness + total-consistency + row-builder | Test overlap with existing blindness test; keep history-path-specific |

**Prerequisites:** S-04 merged on `main` (done). Local Supabase stack for the `rls` test lane.
**Estimated effort:** ~1–2 sessions across 4 phases (UI-light, no migration).

## Open Risks & Assumptions

- Relies on existing `predictions` RLS for the blindness boundary — the app filter is a friendly mirror, not the guard. The Phase 4 DB test must prove this holds on the history read path.
- Own-page listing rule ("prediction or result") refines the roadmap's "all matches listed" wording — reconciled in the Phase 1 roadmap update.
- Running-total-equals-leaderboard-total holds only while points are sourced from `prediction_scores`; recomputing in TS would risk drift.

## Success Criteria (Summary)

- A participant sees their own prediction/result/points per match with a running total matching the leaderboard.
- Any participant's revealed history is viewable from the leaderboard, with no pre-kickoff prediction ever shown.
- FR-021b and the roadmap S-05 entry document the capability; automated + DB tests pass in CI.
