# Fix "See Others' Predictions" Zero-Points Bug — Plan Brief

> Full plan: `context/changes/match-predictions-row-cap/plan.md`

## What & Why

The "See others' predictions" dialog shows `0 pts` for participants who actually
scored, even though the leaderboard totals are correct. Supabase's
`max_rows = 1000` cap silently truncates the two all-participants reads in
`loadMatchPredictions`, so score rows go missing and the UI renders the gap as a
fake `0`. We paginate those reads, and stop the UI from disguising missing data
as a real zero.

## Starting Point

`loadMatchPredictions` (`src/lib/match-predictions.ts`) runs four RLS reads and
merges them. Two of them — `predictions` and `prediction_scores`, filtered by
`.in("match_id", …)` — grow as `participants × kicked-off matches` and have no
`.range()`, so they truncate at 1000 rows. The leaderboard is unaffected (it
reads a pre-aggregated view, one row per participant), and `history.ts` is
unaffected (single-`predictor_id` reads). The merge already returns `null` for
missing points; the dialog masks it with `?? 0`.

## Desired End State

Scored participants always show their real points in the dialog no matter how
large the tournament grows, and a genuinely-missing score renders as `—` rather
than `0`, so any future gap is visible instead of silent.

## Key Decisions Made

| Decision               | Choice                                    | Why (1 sentence)                                                        | Source |
| ---------------------- | ----------------------------------------- | ----------------------------------------------------------------------- | ------ |
| Read completeness      | Paginate with `.range()` until exhausted  | Fixes the root cause fully with the smallest, config-independent change | Plan   |
| Missing-points display | `—` for `null`, `0 pts` only for real 0   | Stops missing data from masquerading as a scored zero                   | Plan   |
| Regression coverage    | Both unit (helper) + live-DB (>1000 rows) | Fast CI guard plus an end-to-end proof against the real cap             | Plan   |
| Page ordering          | Explicit `.order()` on paginated reads    | Stable page boundaries so `.range()` doesn't skip/duplicate rows        | Plan   |
| Display testability    | Pure `formatPoints` helper                | No React testing-library in deps; mirrors existing pure-helper pattern  | Plan   |

## Scope

**In scope:**

- Generic `readAllPages` helper + apply to the two fan-out reads.
- `formatPoints` helper + dialog wiring.
- Unit tests (helper, formatter) + live-DB over-cap regression test.

**Out of scope:**

- Raising `max_rows`; per-match on-demand refetch/new API route.
- Scoring, RLS, views, migrations.
- Paginating the `roster` read (bounded; carries FR-020 ordering) or `results`
  read (one row per match).

## Architecture / Approach

A single pure-ish pagination helper (takes a page-fetch callback, loops
`.range()` until a short page) wraps the `predictions` and `prediction_scores`
reads, each given a deterministic `.order()`. The merge and SSR page flow are
untouched. Display goes through a pure `formatPoints` for testability.

## Phases at a Glance

| Phase                 | What it delivers                  | Key risk                                              |
| --------------------- | --------------------------------- | ----------------------------------------------------- |
| 1. Paginated reads    | Complete reads regardless of size | Page ordering must be deterministic or rows skip/dupe |
| 2. Points display     | `—` vs `0 pts` distinction        | Must not turn a real `0` into `—`                     |
| 3. Live-DB regression | End-to-end proof past 1000 rows   | Seeding volume is slow; opt-in/self-skipping          |

**Prerequisites:** Local Supabase stack for Phase 3 (`npx supabase start` + env
vars); Phases 1-2 need none.
**Estimated effort:** ~1 focused session across 3 small phases.

## Open Risks & Assumptions

- The hosted project's PostgREST `max_rows` matches `config.toml` (1000);
  pagination is correct regardless of the exact value.
- The `roster` read is assumed bounded (< 1000 participants) — true for a
  private pool; noted rather than paginated to preserve its ordering.
- Cross-request `.range()` paging assumes a stable total order, enforced via the
  added `.order()`.

## Success Criteria (Summary)

- Scored participants show correct non-zero points in "See others' predictions"
  on datasets exceeding 1000 rows.
- Missing points render as `—`; real zeros render as `0 pts`.
- Unit tests (CI) and the opt-in live-DB over-cap test pass.
