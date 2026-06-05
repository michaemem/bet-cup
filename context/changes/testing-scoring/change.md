---
change_id: testing-scoring
title: Test scoring & ranking correctness (test-plan Phase 1)
status: implementing
created: 2026-06-04
updated: 2026-06-05
archived_at: null
---

## Notes

Rollout Phase 1 of context/foundation/test-plan.md: "Scoring & ranking correctness".

Risks covered:
- #2: points computed wrong for a (prediction, result) pair, or a result correction fails to recompute affected scores.
- #7: leaderboard ranks participants wrongly — wrong totals or wrong tie-break order.

Test types planned: unit (or DB-level if scoring is implemented in SQL).

Risk response intent:
- #2: prove FR-018's 3/2/1/0 is correct across the full prediction × result grid (incl. draws and negative goal-difference) AND that a corrected result re-scores every affected prediction; do not treat "saved" as "recomputed"; do not lift the expected score from the implementation under test.
- #7: prove ranking follows total points → exact-score count → alphabetical-by-name (case-insensitive) deterministically, including genuine tie cases.
