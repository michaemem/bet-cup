---
change_id: testing-blindness-ownership
title: Blindness & ownership at the DB boundary (test rollout Phase 2)
status: implemented
created: 2026-06-05
updated: 2026-06-08
archived_at: null
---

## Notes

Rollout Phase 2 of context/foundation/test-plan.md: "Blindness & ownership at the DB boundary".

Risks covered: #1 (a participant's/admin's prediction is visible to others before that match's kickoff), #3 (one participant creates/edits/deletes another's prediction — IDOR/ownership), #5 (service-role client or misscoped server action bypasses RLS and exposes predictions). Test types planned: integration (RLS vs live Supabase).

Risk response intent:
- #1: prove a non-predictor's row-fetch for an un-kicked match returns zero prediction values, and the values only become visible to all after kickoff — the admin is NOT exempt from blindness; assert the actual row-fetch, not UI state.
- #3: prove that acting as participant A cannot mutate B's prediction and the server rejects a spoofed owner id, trusting only the session identity; do not test only the legitimate-owner path.
- #5: prove service-role usage is confined to participant creation and never reads predictions — assert production reads / importer count rather than grep-across-src (per lessons.md).
