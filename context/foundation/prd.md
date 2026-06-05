---
project: "BetCup"
version: 1
status: draft
created: 2026-05-19
context_type: greenfield
product_type: web-app
target_scale:
  users: small
  qps: low
  data_volume: small
timeline_budget:
  mvp_weeks: 3
  hard_deadline: null
  after_hours_only: true
---

# BetCup — Product Requirements Document

## Vision & Problem Statement

Running a private prediction pool during a major football tournament (FIFA World Cup, UEFA EURO) is manual, error-prone, and time-consuming for the friend who ends up organizing it. During group stages — when several matches happen across a few days — the organizer has to chase participants for predictions, keep those predictions hidden until kickoff to avoid influence, enter actual results match-by-match, and recompute the standings before the next slate. The cost is the organizer's time and the integrity risk that someone peeks at a prediction or that scoring is miscomputed.

Existing tournament-prediction apps (Kicktipp, Superbru, sweepstakes spreadsheets) are built around public leaderboards and self-registration — a different shape than what a closed friend group actually wants. A private pool, where a trusted admin controls who joins and the only audience is each other, is a small but distinct product surface. BetCup targets that shape directly: one admin, one tournament, one friend group, no public exposure.

## User & Persona

**Primary persona — "the organizer".** The friend in a group of 5–20 who ends up running the prediction pool. Not a professional organizer; just the person who volunteered (or got volunteered). They reach for BetCup at the start of a tournament when they realize spreadsheets and group chats don't scale to 48+ matches and want a tool that automates collection, hiding, and scoring without exposing the pool to the public internet. They know their participants by name and can create accounts for them by hand.

**Persona scope.** Single known group, single tournament, single admin. No self-registration, no multi-tenancy.

## Success Criteria

### Primary

- A real friend group runs one full tournament end-to-end on BetCup: the admin creates the tournament and adds every match; every participant submits predictions before kickoff for every match they want to play; the admin enters every actual result; and the leaderboard at the end of the tournament reflects the agreed-on scoring schema correctly.

### Secondary

- Participants return to the app match-after-match without being chased — BetCup is sticky enough to replace the manual prompts in the group chat.

### Guardrails

- A participant's prediction is NEVER visible to any other participant before the scheduled kickoff time of that match. This is the integrity invariant; violating it once nullifies the product.
- Scoring is mathematically correct for every entered result against every submitted prediction — no silent miscalculations, no off-by-one. If the admin corrects a result, the leaderboard recomputes correctly.

## User Stories

### US-01: Participant submits a prediction before kickoff

- **Given** a logged-in participant viewing the list of upcoming matches
- **When** they pick a match whose scheduled kickoff is in the future, enter a home score and an away score, and confirm
- **Then** the prediction is saved and visible only to them; no other participant or the admin can see it; the participant can return and edit the same prediction any time before kickoff

#### Acceptance Criteria

- The prediction saves successfully and appears on the participant's own "my predictions" view immediately.
- Other participants viewing the same match before kickoff see the match details and (optionally) who has predicted, but NOT the prediction values themselves.
- The admin viewing the same match before kickoff sees the same — match details and prediction-status, but no prediction values.
- After the match's scheduled kickoff time, the participant cannot edit or create a prediction for that match; the UI clearly indicates the match is locked.
- After kickoff, the prediction values become visible to all participants.

### US-02: Admin enters a result and the leaderboard updates

- **Given** the admin viewing a match whose scheduled kickoff has passed and which has no result entered
- **When** the admin enters the actual home score and away score and confirms
- **Then** every participant's prediction for that match is scored against the result using the agreed scoring rule, and the leaderboard reflects the new totals immediately

#### Acceptance Criteria

- Each scored prediction is computed correctly per FR-018.
- A participant who did not predict scores 0 for that match (FR-019), and this is reflected in their visible match history.
- If the admin re-enters or edits the result later (FR-010), all affected prediction scores recompute and the leaderboard updates accordingly.
- The leaderboard ranks participants by total points across all matches with results entered to date.

## Functional Requirements

### Authentication & Accounts

- FR-001: Admin can create a participant account by entering name, login (email or username), and an initial password. Priority: must-have
- FR-002: Participant can log in with their login and password. Priority: must-have
- FR-003: User (participant or admin) can change their own password after logging in; changing it requires confirming the current password and signs out other sessions. Priority: must-have
- FR-004: Admin can delete a participant account; that participant's predictions and earned points are removed from the leaderboard. Deletion is a cascade-delete (hard delete of the participant row plus their predictions and earned points); no soft-delete / audit trail is retained in the MVP. Priority: must-have
  > Decision (2026-05-28, roadmap Q-02 / #10): cascade-delete chosen over soft-delete — the PRD wording reads as a hard delete, the MVP is single-tournament so an audit trail has no consumer, and a forgotten "inactive" filter in a future query would be a silent leaderboard bug.
- FR-005: Unauthenticated visitor is redirected to the login page from any other route. Priority: must-have
- FR-023: User (participant or admin) can change their own display name — the name shown on the leaderboard and in other participants' revealed history. Changing it requires confirming the current password; display names need not be unique. Priority: must-have

### Tournament & Match Management

- FR-006: Admin can create the (single) tournament with a name. Priority: must-have
- FR-007: Admin can add a match to the tournament by entering home team, away team, and kickoff date and time. Priority: must-have
  > Socratic: Counter-argument considered: "tournaments have 48–64 matches; entering one-by-one is painful and error-prone." Resolution: kept as written but FR-022 (bulk paste entry) added alongside it, so the admin has both flows.
- FR-008: Admin can edit a match's teams, date, or kickoff time before kickoff. Priority: must-have
- FR-009: Admin can enter the actual result (home score, away score) for a match after its kickoff. Priority: must-have
- FR-010: Admin can correct a previously entered result; affected scores recompute automatically. Priority: must-have
- FR-022: Admin can bulk-add matches by pasting a multi-line list, where each line is one match in a fixed format (e.g., `<home team> - <away team> | <YYYY-MM-DD HH:MM>`); the app parses the list, previews the parsed matches, and the admin confirms before saving. Parse errors on individual lines are surfaced inline so the admin can correct them. Priority: must-have

### Predictions

- FR-011: Participant can view all matches in the tournament with their scheduled kickoff times. Priority: must-have
- FR-012: Participant can submit a prediction (home score, away score) for any match before its scheduled kickoff. Priority: must-have
- FR-013: Participant can edit or replace their prediction for a match at any time up to that match's scheduled kickoff. Priority: must-have
  > Socratic: Counter-argument considered: "single-shot predictions are simpler to model and remove the 'when did they actually decide?' question." Resolution: kept; humans change their minds and locking on first submit feels punitive in a casual friend pool. The kickoff-lock rule (FR-014) is the only objective lock point.
- FR-014: Once a match's scheduled kickoff has passed, predictions for that match cannot be created or edited. Priority: must-have
- FR-015: Before kickoff, ONLY the participant who submitted a prediction can see it. No other participant — and not the admin either — can view it. Priority: must-have
  > Socratic: Counter-argument considered: "the admin operationally has DB access; UI-blindness is symbolic unless predictions are encrypted at rest." Resolution: kept as written. UI-blindness is the explicit contract — it prevents accidents (admin glancing at the screen during data entry), signals intent, and is cheap to implement. Encrypt-at-rest was considered and rejected as too costly for the MVP; the trust model assumes the admin won't read the DB.
- FR-016: After kickoff, all submitted predictions for that match become visible to all participants. Priority: must-have
- FR-017: Admin is also a participant: the admin can submit predictions like any participant, subject to the same kickoff lock and the same blindness rule (FR-015). Priority: must-have
  > Socratic: Counter-argument considered: "admin playing creates a perceived conflict-of-interest, even if FR-015 protects fairness." Resolution: kept; in friend-group pools the organizer almost always wants to play, and FR-015 (UI-blindness, including from admin) plus FR-014 (kickoff lock) protect fairness as well as a separate-account workaround would. The cleanest single-role-per-person model is rejected as out-of-touch with how friend groups actually use this kind of tool.

### Scoring & Leaderboard

- FR-018: System computes points for a (prediction, result) pair using: 3 pts if the prediction matches the exact score; else 2 pts if the prediction has the correct goal difference and matches the actual outcome (winner/draw); else 1 pt if the prediction matches only the actual outcome; else 0 pts. Priority: must-have
- FR-019: A participant who did not submit a prediction for a match earns 0 points for that match. Priority: must-have
- FR-020: Participant can view the leaderboard showing all participants ranked by total points across all played matches. Ties are broken by exact-score-prediction count (more 3-point predictions ranks higher); if a tie still remains, participants are ordered alphabetically by name (case-insensitive, ascending). Priority: must-have
  > Decision (2026-05-28, roadmap Q-01 / #9): primary tie-break is the count of exact-score (3-point) predictions, with alphabetical-by-name as the final deterministic fallback. Chosen over a plain alphabetical default because it rewards prediction precision while staying cheap and deterministic.
- FR-021: Participant can view their own match-by-match history: each of their predictions, the actual result (when entered), and points earned. Priority: must-have
- FR-021b: Participant can view any other participant's match-by-match history for matches whose scheduled kickoff has passed — that participant's revealed prediction, the actual result (when entered), and points earned. Pre-kickoff predictions remain hidden per FR-015. A match appears in a history view when the viewed participant has a prediction for it or a result has been entered. Priority: must-have

> Socratic: targeted challenge run on FR-007, FR-013, FR-015, FR-017 (the FRs flagged as most likely to be contested). See blockquotes under each. The remaining FRs (FR-001..FR-006, FR-008..FR-012, FR-014, FR-016, FR-018..FR-021) were not individually challenged; if any becomes contested during `/10x-frame` or `/10x-plan`, run a per-FR Socratic round at that point.

## Non-Functional Requirements

- A participant's submitted prediction does not appear on any other participant's screen — nor on the admin's screen — at any time before the scheduled kickoff of that match. After kickoff, all participants' predictions for that match become visible to all participants.
- For every (prediction, result) pair the participant sees, the displayed point value equals the value defined by the scoring rule (FR-018). After an admin result correction, all affected displayed scores reflect the corrected result within the same browsing session.

## Business Logic

**BetCup awards each participant points for each match by comparing their prediction to the actual result, where exact-score predictions earn the most, correct-difference predictions earn fewer, and merely-correct-outcome predictions earn the fewest.**

Inputs to the rule are user-facing values: a participant's prediction (a pair of integers — home goals and away goals) and the match's actual result (a pair of integers entered by the admin). The output is a point value between 0 and 3 inclusive: 3 if the prediction matches the actual score exactly; otherwise 2 if the prediction's goal difference equals the actual goal difference *and* the prediction picks the correct outcome (winner or draw); otherwise 1 if the prediction picks the correct outcome only; otherwise 0. A participant who did not submit a prediction earns 0 points for that match.

The participant encounters the rule's output in two places: their own match-by-match history (per-match points + running total), and the leaderboard (sum of per-match points across all played matches, ranked descending). The rule is hardcoded for v1 — configurable scoring schemas are explicitly out of scope.

## Access Control

Two roles: **admin** and **participant**.

- **Admin** can: create participant accounts, create the tournament, add matches (teams, date, time), enter actual match results, and view the leaderboard. There is exactly one admin in the MVP.
- **Participant** can: log in with their own credentials, submit and edit their predictions before kickoff, view the leaderboard, and view their own past predictions and scores. Participants cannot see other participants' predictions until kickoff.

**Authentication.** Login + password. No self-registration — accounts only come into existence when the admin creates them. The admin sets each participant's initial password and shares it out-of-band (chat, in person, etc.). Both roles (participant and admin) can change their own password and display name from a settings page after logging in; each change requires confirming the current password, and a password change signs out the user's other sessions.

**Unauthenticated access.** Any route except the login page redirects unauthenticated users to login. There is no public landing page; BetCup is private by default.

## Non-Goals

- **Multiple tournaments.** The MVP supports exactly one tournament. Adding a tournament selector, cross-tournament leaderboards, or per-user tournament membership is post-MVP. — Rationale: collapses the data model and most of the UI.
- **Self-registration.** Participants cannot create their own accounts. Only the admin creates accounts. — Rationale: the product is a private friend pool by design; public sign-up is a different product.
- **Configurable scoring rules.** The scoring rule is hardcoded as 3 / 2 / 1 / 0 (see Business Logic). The admin cannot change it per tournament or per match. — Rationale: configurability adds a domain-modeling burden for zero MVP value.
- **External sports/fixtures integration.** The admin enters every match and every result by hand. No integration with third-party fixture or result providers. — Rationale: every external integration is a 1-week tax on a 3-week project; manual entry is acceptable for one tournament.
- **Notifications of any kind.** No email, no push, no SMS, no in-app banners reminding participants to predict. — Rationale: no notification infrastructure to build, deliver, or test.
- **Native mobile app.** The web app must be usable on mobile browsers, but no iOS/Android native app, no installable home-screen prompt, no mobile-specific UI work. — Rationale: scope discipline.
- **Real-time updates.** No live leaderboard streaming, no live match-score feed, no real-time push channel. The leaderboard updates the next time a participant loads the page after the admin enters a result. — Rationale: real-time has high implementation cost relative to the rare moments it would be visible.

## Open Questions

No open questions surfaced from `/10x-shape`'s closing cross-check — all six greenfield gate elements were present (Access Control, Business Logic one-sentence rule, project artifacts, timeline-cost acknowledgment, Non-Goals, preserved-behavior n/a). This section exists per the schema contract and remains the canonical landing pad for any unresolved questions that surface during downstream `/10x-tech-stack-selector`, `/10x-frame`, or `/10x-plan` work — append numbered entries as needed.
