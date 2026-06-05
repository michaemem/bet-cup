---
project: BetCup
version: 1
status: draft
created: 2026-05-28
updated: 2026-06-05
prd_version: 1
main_goal: speed
top_blocker: time
---

# Roadmap: BetCup

> Derived from `context/foundation/prd.md` (v1) + auto-researched codebase baseline (2026-05-28).
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Vision recap

BetCup is a private prediction pool for one friend group running one football tournament. The differentiator vs. existing tools (Kicktipp, Superbru) is shape: a closed pool with one admin who creates accounts by hand and a strict integrity invariant that no participant — and not even the admin — sees another participant's prediction before kickoff. The MVP target is a real friend group running one full tournament end-to-end on the app, in three weeks of after-hours work.

## North star

**S-04: admin enters a result and the leaderboard updates correctly** — when this slice ships end-to-end, every load-bearing piece of the product has been exercised: predictions must have been saved correctly under the kickoff-lock and blindness rules (US-01), results must be enterable and correctable (FR-009/010), scoring must compute per FR-018, and the leaderboard must rank participants by total points (FR-020).

> "North star" here means the smallest end-to-end slice whose successful delivery would prove the core product hypothesis ("a private friend pool can run a tournament correctly"); it's placed as early as `Prerequisites` allow because everything else only matters if this works.

## At a glance

| ID | Change ID | Outcome (user can …) | Prerequisites | PRD refs | Status |
|---|---|---|---|---|---|
| F-01 | identity-boundary | (foundation) every route is gated; only admin can mint participants; data model has a clean role split | — | FR-005, FR-017, Access Control, Non-Goals (self-registration) | done |
| S-01 | admin-creates-participants | admin creates a named participant with an initial password and that participant logs in successfully | F-01 | FR-001, FR-002 | done |
| S-02 | tournament-and-matches | admin creates the tournament and populates its match list (one-by-one or via bulk paste), and edits matches before kickoff | F-01 | FR-006, FR-007, FR-008, FR-022 | done |
| S-03 | prediction-with-blindness | participant submits and edits a prediction before kickoff; only the predictor can see it; after kickoff editing is blocked | F-01, S-02 | US-01, FR-011, FR-012, FR-013, FR-014, FR-015, FR-017 | done |
| S-04 | results-scoring-leaderboard | admin enters/corrects a result, per-prediction points compute correctly, post-kickoff predictions become visible, the leaderboard ranks all participants | F-01, S-02, S-03 | US-02, FR-009, FR-010, FR-016, FR-018, FR-019, FR-020 | done |
| S-05 | participant-match-history | participant reviews their own match-by-match history (prediction, result, points) and views any other participant's revealed (post-kickoff) history from the leaderboard | S-04 | FR-021, FR-021b | proposed |
| S-06 | delete-participant | admin removes a participant; their predictions and earned points disappear from history and the leaderboard | S-01, S-04 | FR-004 | proposed |
| S-07 | participant-changes-password | participant changes their own password from a settings page after first login | F-01 | FR-003 | proposed |

## Streams

Navigation aid — groups items that share a `Prerequisites` chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme | Chain | Note |
|---|---|---|---|
| A | Setup | `F-01` → (`S-01` ∥ `S-02`) | Identity boundary first; then admin readies the world. `S-01` and `S-02` can run in parallel — under `top_blocker: time` this is the cheapest fan-out. |
| B | North-star path | `S-03` → `S-04` | The validation milestone: integrity invariant (FR-015 blindness) plus scoring correctness. Joins Stream A at `S-02` (matches must exist) and at `S-01` (testable participants speed up `S-03`). |
| C | Fan-out polish | `S-05`, `S-06`, `S-07` | Reachable in parallel after `S-04` (or earlier for `S-07`, which only needs `F-01`). Order driven by what the first real users hit first; `S-07` is deferred under `speed` because it is orthogonal to the must-have validation path. |

## Baseline

What's already in place in the codebase as of 2026-05-28 (auto-researched + user-confirmed). Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** present — Astro 6 SSR + React 19 + Tailwind 4 + `cn()` wired (`astro.config.mjs`, `src/lib/utils.ts`); shadcn `button` primitive in `src/components/ui/button.tsx`; auth pages (`signin.astro`, `signup.astro`, `confirm-email.astro`) and a `dashboard.astro` exist; no tournament/matches/predictions/leaderboard pages.
- **Backend / API:** partial — three handlers under `src/pages/api/auth/` (signin/signout/signup) exist with `POST` exports, but **none export `const prerender = false`** (an AGENTS.md hard rule); no `zod` validation; no `src/lib/services/`. F-01 plus the first slice consuming each handler tightens this.
- **Data:** absent — `supabase/config.toml` present but **no `supabase/migrations/`**, no application tables (participants / tournaments / matches / predictions), **no RLS policies**, no generated TS DB types. F-01 establishes migration workflow + the `profiles`/role table; per-domain tables land in their owning slices.
- **Auth:** partial — `src/lib/supabase.ts` SSR client via `@supabase/ssr`; `src/middleware.ts` protects `/dashboard` and sets `context.locals.user`; sign-in/sign-up/confirm-email pages built; secrets read via `astro:env/server`. **Crucial mismatch with PRD non-goal #2:** the existing `signup.astro` + `/api/auth/signup` is open self-registration, which the PRD forbids; it must be removed (handled in F-01). Change-password (FR-003) is absent and lands in S-07.
- **Deploy / infra:** present — `wrangler.jsonc` with `compatibility_flags: ["nodejs_compat"]`; `@astrojs/cloudflare` adapter wired in `astro.config.mjs`; `.github/workflows/ci.yml` runs `check:wrangler` + lint + build on PR/push and auto-deploys to Cloudflare on push to `main`; `.env.example` present.
- **Observability:** absent — no Sentry/Datadog/OTEL/pino/winston; no structured logging in middleware or API routes; no 404/500/error-boundary pages. Deferred to `## Parked` under `main_goal: speed`.

## Foundations

### F-01: Identity boundary

- **Outcome:** (foundation) every non-public route redirects unauthenticated visitors to `/auth/signin`; the data model has a `profiles`+`role` split distinguishing admin from participant; the single admin is seeded; the existing self-registration endpoint and UI are removed; subsequent slices have a reliable migration + type-generation contract to build on.
- **Change ID:** `identity-boundary`
- **PRD refs:** FR-005, FR-017, Access Control, Non-Goals (self-registration)
- **Unlocks:** every downstream slice (`S-01`..`S-07`); makes the FR-015 blindness invariant assertable at the DB layer (every per-domain RLS policy in later slices builds on the `profiles.role` column established here).
- **Prerequisites:** —
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - How is the single admin seeded — manual `INSERT` in a first migration, or env-driven bootstrap on first deploy? Owner: user. Block: no.
  - Does `profiles` mirror `auth.users` 1:1 with a `role` column, or is there a separate `participants` table joined to auth? Owner: `/10x-plan`. Block: no.
- **Risk:** keeping the existing self-signup live alongside admin-creates-participant work would create incoherent app state during the build window (a participant could self-register while the admin onboards another). Removing it as part of the foundation closes that window before any user-facing slice ships.
- **Status:** done

## Slices

### S-01: Admin creates participant accounts

- **Outcome:** admin creates a named participant by entering name, login, and an initial password; the participant logs in successfully on the next attempt with those credentials.
- **Change ID:** `admin-creates-participants`
- **PRD refs:** FR-001, FR-002
- **Prerequisites:** F-01
- **Parallel with:** S-02, S-07
- **Blockers:** —
- **Unknowns:**
  - Which Supabase API surface backs admin-creates-participant? The Supabase admin API requires the service-role key, but `AGENTS.md` flags service-role as a hard guard because it bypasses RLS and would silently break FR-015. The likely shape is a server-only endpoint that uses the service-role key in a tightly scoped context limited to participant creation (never reading predictions). Owner: `/10x-plan`. Block: no.
- **Risk:** misuse of the service-role key in this slice (e.g., reusing the same client elsewhere) is the single most likely path to breaking FR-015 blindness. Scoping the service-role surface to one server-only function and asserting it in code review is the mitigation.
- **Status:** done

### S-02: Admin creates the tournament and adds matches

- **Outcome:** admin creates the (single) tournament with a name, populates its match list either by entering matches one-by-one (home, away, kickoff) or by pasting a multi-line list in a fixed format with parsed-preview-then-confirm, and edits any match's teams or kickoff before that match's kickoff.
- **Change ID:** `tournament-and-matches`
- **PRD refs:** FR-006, FR-007, FR-008, FR-022
- **Prerequisites:** F-01
- **Parallel with:** S-01, S-07
- **Blockers:** —
- **Unknowns:**
  - Bulk-paste grammar: does it tolerate whitespace variations and missing seconds? What time zone does the admin enter — local + assumed-server-TZ, or required UTC? Owner: `/10x-plan`. Block: no.
  - Edit-before-kickoff (FR-008): is the cutoff "kickoff_time > now()" enforced at the DB (RLS) or at the API layer? Owner: `/10x-plan`. Block: no.
- **Risk:** the bulk-paste UX is the single largest piece of admin-facing work in the MVP; if it slips, the admin falls back to the one-by-one flow (FR-007), which is functionally sufficient — so the slice has a built-in graceful degradation. Sequencing this before `S-03` is non-negotiable: there's no prediction without matches.
- **Status:** done

### S-03: Participant submits and edits predictions before kickoff (with blindness)

- **Outcome:** logged-in participant views the full match list with kickoff times; for any match whose kickoff is in the future, they enter and confirm a (home, away) prediction; they can return and edit that prediction any time before kickoff; only they can see their prediction before kickoff (no other participant, not the admin); after kickoff the UI clearly indicates the match is locked. The admin (also a participant per FR-017) is subject to the same lock and the same blindness rule.
- **Change ID:** `prediction-with-blindness`
- **PRD refs:** US-01, FR-011, FR-012, FR-013, FR-014, FR-015, FR-017
- **Prerequisites:** F-01, S-02
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - RLS policy shape for `predictions`: `SELECT WHERE (predictor_id = auth.uid()) OR (kickoff_time < now())`. Confirm `now()` evaluates per-row at fetch time and there's no caching path that could leak a prediction for a few seconds across the kickoff boundary. Owner: `/10x-plan`. Block: no.
  - Time source for the kickoff lock — server-side only (Postgres `now()` and Astro server clock), or also a client-side guard for snappier UX with the server as source-of-truth? Owner: `/10x-plan`. Block: no.
- **Risk:** this is the integrity-load-bearing slice. The PRD's `## Success Criteria` says "violating it once nullifies the product" — so the cost of a single FR-015 leak is unrecoverable for this tournament. Mitigation lives in the RLS shape (DB-enforced, not just UI-enforced) plus an integration test that asserts a non-predictor's row-fetch returns zero rows for an unkicked match.
- **Status:** done

### S-04: Admin enters a result, scoring computes, leaderboard updates  (north star)

- **Outcome:** admin views a kickoff-passed match with no result entered, enters home/away scores and confirms; every participant's prediction for that match is scored per FR-018 (3 / 2 / 1 / 0); the post-kickoff predictions become visible to all participants (FR-016); the leaderboard ranks all participants by total points across all played matches and reflects the new totals immediately. If the admin re-enters the result, all affected per-prediction scores recompute and the leaderboard updates.
- **Change ID:** `results-scoring-leaderboard`
- **PRD refs:** US-02, FR-009, FR-010, FR-016, FR-018, FR-019, FR-020
- **Prerequisites:** F-01, S-02, S-03
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - Scoring computation strategy: a Postgres view that computes points on read (always-correct, never stale, more read cost) vs. a materialized score column written when a result is entered/corrected (faster reads, has to be invalidated on every result edit). Owner: `/10x-plan`. Block: no.
  - Leaderboard tie-break rule: **RESOLVED 2026-05-28 (#9).** Rank by total points; break ties by exact-score-prediction count (more 3-pointers wins); if still tied, alphabetical by participant name (case-insensitive, ascending). See `## Open Roadmap Questions` §1.
- **Risk:** scoring correctness is the second `## Success Criteria` guardrail. An off-by-one in the goal-difference branch of FR-018 silently rewards or penalizes participants; the rule is small enough to be unit-tested exhaustively against a 4×4 grid of sample (prediction, result) pairs, and that test pinning is the mitigation.
- **Status:** done

### S-05: Participant match-by-match history

- **Outcome:** (a) participant opens a "my history" view and sees their own prediction, the actual result (when entered), and the points earned for each match they predicted or that has a result; a match they predicted but that has no result yet is listed showing the prediction but no points; future matches they have not predicted are omitted. Their running point total matches the leaderboard total for them. (b) clicking any name on the leaderboard opens that participant's history, showing only kicked-off matches — their revealed predictions, results, and points — never their pre-kickoff picks (blindness preserved per FR-015). Listing rule (both views): a match appears when the viewed participant has a prediction for it or a result exists.
- **Change ID:** `participant-match-history`
- **PRD refs:** FR-021, FR-021b
- **Prerequisites:** S-04
- **Parallel with:** S-06, S-07
- **Blockers:** —
- **Unknowns:** —
- **Risk:** small slice riding on `S-04`'s scoring contract; if the per-match number here doesn't match the leaderboard total, the user-visible inconsistency erodes trust in scoring more than a missing feature would.
- **Status:** proposed

### S-06: Admin deletes a participant

- **Outcome:** admin removes a participant from a "manage participants" view; that participant's predictions and earned points disappear from any other participant's history view and from the leaderboard (the deleted participant no longer appears in standings).
- **Change ID:** `delete-participant`
- **PRD refs:** FR-004
- **Prerequisites:** S-01, S-04
- **Parallel with:** S-05, S-07
- **Blockers:** —
- **Unknowns:**
  - Delete shape: **RESOLVED 2026-05-28 (#10).** Cascade-delete — hard delete of the participant row plus their predictions and earned points. See `## Open Roadmap Questions` §2.
- **Risk:** a deletion that doesn't cascade through to the leaderboard would leave a "ghost" entry — confusing but not security-breaking. Asserting absence in an integration test after delete is the mitigation.
- **Status:** proposed

### S-07: Participant changes their own password

- **Outcome:** logged-in participant opens a settings page, enters their current password and a new password, confirms; subsequent logins use the new password and the old password no longer works.
- **Change ID:** `participant-changes-password`
- **PRD refs:** FR-003
- **Prerequisites:** F-01
- **Parallel with:** S-01, S-02, S-05, S-06
- **Blockers:** —
- **Unknowns:** —
- **Risk:** lowest-risk slice; Supabase auth has a built-in `updateUser({ password })` flow. Sequenced last under `main_goal: speed` because it's orthogonal to the chain of must-have FRs that lead to the north star (F-01 → S-02 → S-03 → S-04) — but it remains must-have because the admin-set initial-password handoff is incomplete without a way for the participant to rotate it.
- **Status:** proposed

## Backlog Handoff

| Roadmap ID | Change ID | Suggested issue title | Ready for `/10x-plan` | Notes |
|---|---|---|---|---|
| F-01 | identity-boundary | Establish identity boundary: profiles + role + admin seeded + global auth gate; remove self-signup | done | Landed — foundation for all downstream slices |
| S-01 | admin-creates-participants | Admin creates and manages participant accounts | yes | Unblocked (F-01 `done`); change folder created — ready for `/10x-plan` |
| S-02 | tournament-and-matches | Admin creates tournament and adds matches (one-by-one + bulk paste) | done | Landed — admin can create the tournament and populate matches |
| S-03 | prediction-with-blindness | Participant submits and edits predictions before kickoff (with blindness invariant) | yes | Unblocked (F-01 + S-02 `done`) |
| S-04 | results-scoring-leaderboard | Admin enters results; scoring computes; leaderboard updates (north star) | no | Unblocks once F-01 + S-02 + S-03 are `done` |
| S-05 | participant-match-history | Participant views their own and others' revealed match-by-match history (FR-021, FR-021b) | no | Unblocks once S-04 is `done` |
| S-06 | delete-participant | Admin deletes a participant; predictions and points are removed | no | Unblocks once S-01 + S-04 are `done` |
| S-07 | participant-changes-password | Participant changes their own password | yes | Unblocked (F-01 `done`); deferred under `main_goal: speed` |

## Open Roadmap Questions

_All roadmap questions resolved. Decisions recorded inline below and reflected in the PRD FRs and owning slices._

1. **Leaderboard tie-break rule.** ✅ **RESOLVED 2026-05-28 ([#9](https://github.com/michaemem/bet-cup/issues/9)).** Rank by total points; break ties by exact-score-prediction count (more 3-pointers wins); if a tie remains, fall back to alphabetical by participant name (case-insensitive, ascending). Reflected in `S-04` and PRD FR-020.
2. **Soft-delete vs. cascade-delete on participant removal (FR-004).** ✅ **RESOLVED 2026-05-28 ([#10](https://github.com/michaemem/bet-cup/issues/10)).** Cascade-delete — a hard delete of the participant row plus their predictions and earned points (no soft-delete / audit trail in MVP scope). Reflected in `S-06` and PRD FR-004.

## Parked

- **Multiple tournaments.** PRD `## Non-Goals`. Rationale: collapses the data model and most of the UI for the MVP.
- **Self-registration.** PRD `## Non-Goals`. Rationale: the product is a private friend pool by design; the existing self-signup code is removed in F-01 to enforce this.
- **Configurable scoring rules.** PRD `## Non-Goals`. Rationale: configurability adds a domain-modeling burden for zero MVP value.
- **External sports/fixtures integration.** PRD `## Non-Goals`. Rationale: every external integration is a 1-week tax on a 3-week project.
- **Notifications (email / push / SMS / in-app banners).** PRD `## Non-Goals`. Rationale: no notification infrastructure to build, deliver, or test.
- **Native mobile app / PWA install.** PRD `## Non-Goals`. Rationale: scope discipline; mobile-browser usability is enough.
- **Real-time updates (live leaderboard / live match-score feed / WebSocket).** PRD `## Non-Goals`. Rationale: high implementation cost relative to the rare moments it would be visible.
- **Application observability (Sentry / Datadog / structured logging / 404 / 500 pages).** Deferred under `main_goal: speed`. Rationale: Cloudflare Workers Logs (`wrangler tail`) plus the Workers Observability MCP cover the operational view for a 5–20 user pool; investing in app-level observability before the must-have FR chain that leads to the north star lands would compete with `time` (the #1 blocker). Re-evaluate after `S-04` (north star) ships.

## Done

- **F-01: (foundation) every non-public route redirects unauthenticated visitors to `/auth/signin`; the data model has a `profiles`+`role` split distinguishing admin from participant; the single admin is seeded; the existing self-registration endpoint and UI are removed; subsequent slices have a reliable migration + type-generation contract to build on.** — Archived 2026-06-03 → `context/archive/2026-05-28-identity-boundary/`. Lesson: —.
- **S-02: admin creates the (single) tournament with a name, populates its match list either by entering matches one-by-one (home, away, kickoff) or by pasting a multi-line list in a fixed format with parsed-preview-then-confirm, and edits any match's teams or kickoff before that match's kickoff.** — Archived 2026-06-03 → `context/archive/2026-06-01-tournament-and-matches/`. Lesson: —.
- **S-01: admin creates a named participant by entering name, login, and an initial password; the participant logs in successfully on the next attempt with those credentials.** — Archived 2026-06-04 → `context/archive/2026-06-03-admin-creates-participants/`. Lesson: —.
- **S-03: logged-in participant views the full match list with kickoff times; for any match whose kickoff is in the future, they enter and confirm a (home, away) prediction; they can return and edit that prediction any time before kickoff; only they can see their prediction before kickoff (no other participant, not the admin); after kickoff the UI clearly indicates the match is locked. The admin (also a participant per FR-017) is subject to the same lock and the same blindness rule.** — Archived 2026-06-04 → `context/archive/2026-06-04-prediction-with-blindness/`. Lesson: —.
- **S-04: admin views a kickoff-passed match with no result entered, enters home/away scores and confirms; every participant's prediction for that match is scored per FR-018 (3 / 2 / 1 / 0); the post-kickoff predictions become visible to all participants (FR-016); the leaderboard ranks all participants by total points across all played matches and reflects the new totals immediately. If the admin re-enters the result, all affected per-prediction scores recompute and the leaderboard updates.** — Archived 2026-06-05 → `context/archive/2026-06-04-results-scoring-leaderboard/`. Lesson: —.

## GitHub issues

Migrated to [`michaemem/bet-cup`](https://github.com/michaemem/bet-cup) GitHub Issues on 2026-05-28. Tracking milestone: [**BetCup MVP**](https://github.com/michaemem/bet-cup/milestone/1) (10 / 10 open at migration time).

### Foundations and slices

| Roadmap ID | Change ID | Issue | Title |
| --- | --- | --- | --- |
| F-01 | `identity-boundary` | [#1](https://github.com/michaemem/bet-cup/issues/1) | Establish identity boundary: profiles + role + admin seeded + global auth gate |
| S-01 | `admin-creates-participants` | [#2](https://github.com/michaemem/bet-cup/issues/2) | Admin creates and manages participant accounts |
| S-02 | `tournament-and-matches` | [#3](https://github.com/michaemem/bet-cup/issues/3) | Admin creates tournament and adds matches (one-by-one + bulk paste) |
| S-03 | `prediction-with-blindness` | [#4](https://github.com/michaemem/bet-cup/issues/4) | Participant submits and edits predictions before kickoff (with blindness invariant) |
| S-04 | `results-scoring-leaderboard` | [#5](https://github.com/michaemem/bet-cup/issues/5) | Admin enters results; scoring computes; leaderboard updates (north star) |
| S-05 | `participant-match-history` | [#6](https://github.com/michaemem/bet-cup/issues/6) | Participant views their own and any participant's revealed match-by-match history |
| S-06 | `delete-participant` | [#7](https://github.com/michaemem/bet-cup/issues/7) | Admin deletes a participant; predictions and points are removed |
| S-07 | `participant-changes-password` | [#8](https://github.com/michaemem/bet-cup/issues/8) | Participant changes their own password |

### Open Roadmap Questions

| Roadmap section | Question | Issue | Status |
| --- | --- | --- | --- |
| `## Open Roadmap Questions` §1 | Leaderboard tie-break rule | [#9](https://github.com/michaemem/bet-cup/issues/9) | closed — total points, then most exact-score predictions, then alphabetical |
| `## Open Roadmap Questions` §2 | Soft-delete vs. cascade-delete on participant removal (FR-004) | [#10](https://github.com/michaemem/bet-cup/issues/10) | closed — cascade-delete |

### Labels in use

`type:foundation` · `type:slice` · `type:question` · `status:ready` · `status:blocked` · `stream:setup` · `stream:north-star` · `stream:fan-out` · `north-star`

### Status mapping

The roadmap's `Status` field maps onto GitHub issue state and labels:

- `proposed` → open issue, no `status:*` label (default queue state on migration)
- `ready` → open issue with `status:ready` label (currently F-01 / #1 only)
- `blocked` → open issue with `status:blocked` label (none currently)
- `done` → closed issue. `/10x-archive` should close the matching issue when a change archives, and append a corresponding entry to the `## Done` section above.

### Re-migration

This section was appended as a one-shot migration to seed the GitHub backlog from the roadmap's first version. Subsequent edits to the roadmap (new slices, status flips, archived items) should propagate to GitHub manually via `gh issue` commands or by editing the issues directly — there is no automatic sync.
