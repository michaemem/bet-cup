---
change_id: prediction-with-blindness
title: Participant submits and edits predictions before kickoff (with blindness invariant)
status: impl_reviewed
created: 2026-06-04
updated: 2026-06-04
archived_at: null
---

## Notes

S-03 from `context/foundation/roadmap.md`.

Outcome: logged-in participant views the full match list with kickoff times; for any match whose kickoff is in the future, they enter and confirm a (home, away) prediction; they can return and edit that prediction any time before kickoff; only they can see their prediction before kickoff (no other participant, not the admin); after kickoff the UI clearly indicates the match is locked. The admin (also a participant per FR-017) is subject to the same lock and the same blindness rule.

- PRD refs: US-01, FR-011, FR-012, FR-013, FR-014, FR-015, FR-017
- Prerequisites: F-01, S-02 (both `done`)
- GitHub issue: [#4](https://github.com/michaemem/bet-cup/issues/4)

Integrity-load-bearing slice — the FR-015 blindness invariant is DB-enforced (RLS), not just UI-enforced; "violating it once nullifies the product." Open unknowns for `/10x-plan`: exact RLS policy shape for `predictions` (`SELECT WHERE predictor_id = auth.uid() OR kickoff_time < now()`) and the time source for the kickoff lock.
