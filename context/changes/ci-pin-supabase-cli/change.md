---
change_id: ci-pin-supabase-cli
title: Pin Supabase CLI in CI to fix the rls job admin-seed regression
status: impl_reviewed
created: 2026-06-18
updated: 2026-06-18
archived_at: null
---

## Notes

The `rls` CI job (`.github/workflows/ci.yml`) started failing on PR #24 with
`permission denied for table tournaments` in the shared `beforeAll` of ALL 4
RLS suites (`history`, `matches`, `predictions`, `results-scoring`) — i.e. not
caused by the test change in that PR.

Root cause (to confirm/refine before planning):

- The admin user signs in fine but `is_admin()` returns false → the admin-only
  `tournaments_insert` policy (`with check (public.is_admin())`) denies the write.
- `is_admin()` is true only if the `handle_new_user` trigger promoted the seeded
  user to the `admin` role. That promotion depends on the seed running
  `set_config('app.admin_email', …, false)` and the `auth.users` INSERT in the
  SAME session (`supabase/seed.sql.template:15`), applied during `supabase start`.
- CI pins the toolchain loosely: `supabase/setup-cli@v1` with `version: latest`
  (`.github/workflows/ci.yml:98-100`). `main`'s last green `rls` run was
  2026-06-09 (PR #23); no `main` run since, so PR #24 is the first to pull a newer
  Supabase CLI. A newer CLI changing how `seed.sql` is applied
  (session/transaction handling) silently breaks the same-session admin promotion.
- Locally (pinned CLI 2.98.2) all 57 RLS tests pass; CI (`latest`) fails before
  reaching any new test code. This is test-plan Risk #6 (local↔CI drift).

Proposed fix: pin `supabase/setup-cli` to a known-good version (the one green on
2026-06-09) instead of `latest`. Consider also hardening the seed so admin
promotion does not depend on a single-session `set_config` (more robust across
CLI changes). Decide between "pin only" vs "pin + seed hardening" during framing.

Out of scope when first surfaced: this is infra, separate from
`testing-kickoff-lock-actions` (PR #24), which is otherwise green locally and
APPROVED in impl-review. That change is blocked on this CI fix before merge/archive.
