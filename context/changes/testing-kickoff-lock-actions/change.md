---
change_id: testing-kickoff-lock-actions
title: Kickoff-lock & action-layer mutation tests (test-plan Phase 3)
status: impl_reviewed
created: 2026-06-18
updated: 2026-06-18
archived_at: null
---

## Notes

Rollout Phase 3 of `context/foundation/test-plan.md`: "Kickoff-lock & action mutations".
Risks covered: #4 (a prediction is created or edited after its match's kickoff — kickoff-lock bypass), #3 (one participant creates/edits/deletes another participant's prediction — IDOR / ownership), at the server-action layer.
Test types planned: integration around `src/actions`.

Risk response intent:
- #4: prove create/edit is rejected once kickoff has passed and the cutoff uses the SERVER clock, not the client's — the off-by-one at the exact kickoff second matters.
- #3: prove acting as participant A cannot mutate B's prediction, and the server rejects a spoofed owner id, trusting only the session identity (not "logged in" == "owns this row").

Next: `/10x-research` to ground Phase 3 against the live `src/actions` code before planning.
