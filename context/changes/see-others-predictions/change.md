---
change_id: see-others-predictions
title: See other participants' predictions for a kicked-off match (extends S-05)
status: implementing
created: 2026-06-18
updated: 2026-06-18
archived_at: null
---

## Notes

Extends roadmap S-05 (`participant-match-history`). After a match is locked (it
has kicked off / started), each participant gets a "See others' predictions"
button (or similar). Clicking it opens a pop-up showing the other participants'
predictions for that match, listed in the same order as the leaderboard.

Integrity note (must hold): a participant may only see others' predictions for
matches that have kicked off — i.e. past matches (result known) AND the locked
stage (match started but result not yet known). Never before kickoff. This lines
up with the existing `predictions_select` RLS policy (owner OR
`match_is_kicked_off`), so the data access is already permitted at the DB layer;
this change is primarily UI + a read query, likely with no new migration.

### Resolved decisions (2026-06-18, with user)

- **Placement:** button lives on each kicked-off match row in the existing
  `/predictions` page (not on leaderboard/dashboard, no new route).
- **Pop-up contents:** participant name + their prediction; plus points earned
  and the actual result when the match has a result entered. Locked-but-no-result
  matches show predictions only (no points/result yet).
- **Include self:** yes — show all participants including the viewer, with the
  viewer's own row highlighted ("you").
- **No prediction:** participants who did not predict that match are listed with
  a "—" / "No prediction" placeholder (not omitted).
- **Ordering:** global leaderboard standings order (total points → exact-score
  count → alphabetical), matching the main leaderboard — not per-match points.
