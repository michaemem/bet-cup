# S-03 Prediction-with-Blindness — Plan Brief

> Full plan: `context/changes/prediction-with-blindness/plan.md`
> Research: `context/changes/prediction-with-blindness/research.md`

## What & Why

Let a logged-in participant submit and edit a `(home, away)` score prediction for any match before its kickoff, while guaranteeing the FR-015 blindness invariant: **only the predictor can see their prediction before kickoff — not other participants, not the admin.** After kickoff the match locks and all predictions become visible. This is the integrity-load-bearing slice; per the PRD, "violating it once nullifies the product," so the invariant is enforced at the database (RLS) layer and proven by a CI-run test.

## Starting Point

F-01 and S-02 are done: there's a `matches` table (`kickoff_time timestamptz`, admin-only RLS with a `kickoff_time > now()` UPDATE lock), a role model with an `is_admin()` helper, Astro Actions + shared zod, a session SSR Supabase client, an isolated service-role client, and a live-DB RLS test harness. There is no `predictions` table, and `matches`/`tournaments` are not yet readable by participants.

## Desired End State

A participant opens `/predictions`, sees all matches in kickoff order with local times, and enters/edits scores for not-yet-kicked-off matches. A second participant or the admin querying that pre-kickoff prediction gets zero rows from the database. After kickoff, the form locks and predictions are visible to all. A `predictions.rls.test.ts` asserts blindness and the write-lock and runs green in CI against a real Supabase stack.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Blindness SELECT policy | `predictor_id = auth.uid() OR match_is_kicked_off(match_id)`, **no `is_admin()`** | Owner-or-post-kickoff with the admin deliberately not exempt (FR-017). | Research |
| Reaching kickoff in policy | `match_is_kicked_off()` SECURITY DEFINER helper | Mirrors `is_admin()`, keeps policies one-line and reusable across SELECT/INSERT/UPDATE. | Plan |
| Write semantics | `unique(predictor_id, match_id)` + single `predictions.upsert` | Matches "edit replaces" (FR-013), no duplicate states. | Plan |
| Kickoff lock on writes | RLS `NOT match_is_kicked_off` on INSERT+UPDATE + app pre-check + zero-row guard | Upsert can't sneak past kickoff via INSERT; race-proof like `matches.update`. | Plan |
| Score validation | DB CHECK (0–99) + mirrored zod | DB is source of truth even if a write bypasses the form. | Plan |
| `predictor_id` FK | `references profiles(id) ON DELETE CASCADE` | App identity table; cascade satisfies the S-06 cascade-delete decision. | Plan |
| Participant read scope | open SELECT on `matches`/`tournaments` to authenticated | Nothing on those tables is sensitive pre-kickoff; only predictions are. | Plan |
| "Who has predicted" indicator | Deferred | Keeps the blindness surface minimal; the AC is optional. | Plan |
| UI location | dedicated `/predictions` route, linked from dashboard | Matches the page-per-surface convention; default-deny middleware covers it. | Plan |
| Blindness test in CI | `predictions.rls.test.ts` + new Supabase-backed CI `rls` job | The invariant whose breach nullifies the product gets continuous enforcement. | Plan |

## Scope

**In scope:** `predictions` table + RLS + `match_is_kicked_off()` helper; open participant read on `matches`/`tournaments`; shared prediction zod schema; `predictions.upsert` action (session client); `/predictions` page + form island; dashboard link; blindness RLS test + CI job.

**Out of scope:** scoring/results/leaderboard (S-04); prediction history; "who predicted" indicator; admin visibility into pre-kickoff predictions; any new auth mechanism.

## Architecture / Approach

One bottom-up vertical: **DB** (table, helper, blindness SELECT + locked owner writes, widened reads, regenerated types) → **server** (`src/lib/schemas/prediction.ts`, `predictions.upsert` in `src/actions/index.ts` on the session SSR client, never service-role) → **UI** (`/predictions` SSR page → `client:load` island following the `TournamentForm` RHF + zod + actions pattern) → **verification** (`src/db/predictions.rls.test.ts` + a CI `rls` job that boots Supabase). Defense-in-depth: every invariant is enforced in RLS and re-checked in the Action layer.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Migration + RLS | predictions table, `match_is_kicked_off()`, blindness/lock policies, opened reads, types | Getting the SELECT policy exactly right (no admin branch; no kickoff-boundary leak) |
| 2. Schema + Action | shared zod + `predictions.upsert` (session client, lock checks) | Upsert bypassing the lock via INSERT if `WITH CHECK` is incomplete |
| 3. Participant UI | `/predictions` page + form island + dashboard link | Lock/edit UX correctness; serializing only safe data to the island |
| 4. RLS test + CI | `predictions.rls.test.ts` + Supabase-backed CI `rls` job | CI Supabase boot/seed plumbing |

**Prerequisites:** F-01 + S-02 done (they are); local Supabase stack (Docker) for the RLS test; CI secrets already present for build.
**Estimated effort:** ~3–4 sessions across the 4 phases.

## Open Risks & Assumptions

- The blindness SELECT policy is the single load-bearing line; the Phase 4 test (cross-participant AND admin both get 0 rows pre-kickoff) is what proves it — treat a red `rls` job as a release blocker.
- `now()` is assumed to evaluate per-row at fetch time with no caching path that could leak across the kickoff boundary; the post-kickoff-reveal test case guards this.
- Adding a Supabase-backed CI job adds CI time and a setup step; accepted given the stakes.
- Lesson applied: any service-role-isolation claim is phrased against production reads, not a raw `src/` grep (test files reference the key by name).

## Success Criteria (Summary)

- A participant can submit/edit predictions before kickoff and cannot see anyone else's pre-kickoff predictions; the admin can't either.
- After kickoff, the match is locked for editing and all predictions are visible.
- The blindness RLS test runs (not skipped) and passes in CI.
