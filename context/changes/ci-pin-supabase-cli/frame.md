# Frame Brief: CI `rls` job red — admin seed not promoting

> Framing step before /10x-plan. This document captures what is _actually_
> at issue, separated from what was initially assumed.

> ## ⚠️ Correction (post-implementation, 2026-06-18)
>
> **This frame's reframed root cause was WRONG.** It concluded the failure was
> fragile admin-seed promotion (a session-GUC→trigger coupling). Local
> reproduction under CLI v2.107.0 during implementation disproved it:
>
> - After seeding under v2.107.0, the admin **does** hold the `admin` role — the
>   trigger promotion works. The seed was never the problem.
> - The real cause: v2.107.0 defaults the local stack to **asymmetric ES256 JWT
>   signing keys**. The RLS harness' authenticated requests are not honored under
>   that scheme → PostgREST runs them as `anon` → Postgres 42501
>   `permission denied for table tournaments`. Clean version bisect: 2.98.2 →
>   57/57 pass, 2.107.0 → 4 suites fail.
> - Fix: **pin the CLI to 2.98.2** (HS256). The seed experiment was reverted.
>
> **Why the frame missed it**: the Hypothesis Investigation reasoned from the
> symptom and the codebase's sole-promotion-path structure but never reproduced
> against the breaking CLI. Guardrail #5 ("read/reproduce before reaching for
> priors") would have caught this — the decisive evidence (the JWT `alg` header +
> the role actually present in `user_roles`) only appeared on live reproduction.
> The original (incorrect) analysis is preserved verbatim below for the record.

## Reported Observation

The `rls` CI job fails (PR #24) with `permission denied for table tournaments`
in the `beforeAll` of **all 4** `*.rls.test.ts` suites. The admin **signs in
successfully** (the error is at the admin's tournament INSERT, not sign-in), but
the admin-only policy `tournaments_insert WITH CHECK (public.is_admin())` denies
the write — i.e. `is_admin()` is false, so the seeded admin user was created but
never granted the `admin` role. Green locally (pinned CLI 2.98.2) and green on
`main` 2026-06-09; no `main` run since.

## Initial Framing (preserved)

- **User's stated cause or approach**: a newer Supabase CLI (pulled via
  `supabase/setup-cli@v1` `version: latest`) changed how `seed.sql` is applied,
  breaking the same-session `set_config` the `handle_new_user` trigger needs.
- **User's proposed direction**: pin `supabase/setup-cli` to a known-good
  version (possibly also harden the seed).
- **Pre-dispatch narrowing**: leading concern is the **single symptom** — "get
  the `rls` CI job green again"; not (primarily) the broader cross-environment
  fragility.

## Dimension Map

1. **CLI seed-apply behavior** — newer CLI executes `seed.sql` so the
   session-scoped `set_config(..., false)` in statement 1 isn't visible to the
   trigger firing inside the INSERT. ← initial framing (the trigger)
2. **Seed design fragility** — admin promotion depends on a session GUC reaching
   the trigger in the same connection; brittle by construction. ← latent root
3. **Env/key export** — `supabase status -o env` override flags emit wrong keys.
4. **Migrations/trigger not applied** — `handle_new_user` absent.

## Hypothesis Investigation

| Hypothesis                                      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Verdict |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1. CLI seed-apply behavior changed              | Supabase CLI refactored seed execution to an internal `pgx.Batch` runner that parses `seed.sql` into individual statements and queues them (commit `0b92817`, PRs [#4770](https://github.com/supabase/cli/pull/4770), [#4680](https://github.com/supabase/cli/pull/4680)); docs now tell users to put session-affecting `SET` lines specially "at the top of your seed SQL file" — i.e. session/SET semantics across batched statements are version-sensitive. CI pins `version: latest` (`ci.yml:98-100`); last green `rls` was 2026-06-09 under an older CLI; locally 2.98.2 passes all 57. | STRONG  |
| 2. Seed design fragility (sole, unguarded path) | `seed.sql.template:15` session `set_config(..., false)` then INSERT; `handle_new_user` reads `current_setting('app.admin_email', true)` → unset yields NULL → **silent** skip, no error (`20260604153800_participant_username.sql:45,63-66`). No migration/CI/script/fixture provides a fallback; `on conflict do nothing` (`seed.sql.template:59`) means a re-seed never re-promotes an already-created admin.                                                                                                                                                                               | STRONG  |
| 3. Env/key export wrong                         | Admin **sign-in succeeds** → anon key + auth env are valid; failure is post-auth at the data layer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | NONE    |
| 4. Migrations/trigger missing                   | Users are created and authenticate → migrations applied and the trigger fires (it just skips the admin branch).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | NONE    |

## Narrowing Signals

- The error is in the **shared `beforeAll`** of all 4 suites — 3 untouched by
  PR #24 — at the admin tournament insert. Not a test-code regression.
- Admin **can sign in** but `is_admin()` is false → the user exists (seed ran)
  but the `admin` `user_roles` row was never written → the trigger ran without
  `app.admin_email` visible. Pinpoints promotion timing, not seeding or keys.
- Same fragility was **explicitly predicted** in the F-01 design:
  `context/archive/2026-05-28-identity-boundary/plan.md:79` — "without
  `set_config` the FIRST seed run would silently fail to promote the admin."

## Cross-System Convention

Robust local/CI seeding does not couple privileged role assignment to a
session GUC observed by a trigger at INSERT time. The **production** admin
bootstrap already uses a sturdier path (`ALTER DATABASE postgres SET
app.admin_email` under a privileged connection, then create the user —
`README.md:147`), which survives connection boundaries. Local/CI is the fragile
outlier: it deliberately avoids `ALTER DATABASE` (seed role lacks privilege,
`seed.sql.template:8-13`) and leans on the session-scoped `set_config` instead.

## Reframed (or Confirmed) Problem Statement

> **The actual problem to plan around is**: local/CI admin promotion is coupled
> to a session-scoped `set_config('app.admin_email', …, false)` being visible to
> the `handle_new_user` trigger in the same connection — a guarantee the Supabase
> CLI's seed runner no longer provides. The `version: latest` bump merely exposed
> a pre-existing fragility.

The user's stated cause (CLI drift) is the correct **trigger**, so pinning
`setup-cli` will re-green CI immediately and satisfies the single-symptom goal.
But the pin is a stopgap on a time-bomb: it must eventually be lifted, and the
promotion path stays silently fragile (it fails with no error, only a downstream
`permission denied`). The durable fix removes the GUC/trigger-timing dependency
(e.g. seed the `admin` `user_roles` row deterministically rather than relying on
the trigger seeing the session GUC) — but that solution choice belongs to
/10x-plan.

## Confidence

- **HIGH** — strong, converging evidence for both live dimensions; matches a
  documented prior gotcha (F-01) and an independently-confirmed CLI seed-runner
  change; dimensions 3 and 4 are excluded by the sign-in-succeeds signal.

## What Changes for /10x-plan

Plan for **two layers, sequenced to the single-symptom priority**: (1) an
immediate stopgap — pin `supabase/setup-cli` to the known-good version (identify
which version was green on/before 2026-06-09) to re-green the `rls` gate; and
(2) a durable fix that decouples admin promotion from the session-GUC→trigger
timing so the pin can be safely lifted. The plan should decide whether to ship
both now or land the pin first and track the hardening separately.

## References

- Source files: `.github/workflows/ci.yml:98-104`, `supabase/seed.sql.template:6-15,59`,
  `supabase/migrations/20260604153800_participant_username.sql:45,63-66`,
  `supabase/migrations/20260602180000_tournament_and_matches.sql:74-77`,
  `supabase/config.toml:60-65`, `README.md:147`
- Prior decision: `context/archive/2026-05-28-identity-boundary/plan.md:79`
- CLI evidence: supabase/cli commit `0b92817`, PRs #4770, #4680
- Change notes: `context/changes/ci-pin-supabase-cli/change.md`
- Investigation task: admin-promotion trace (Explore)
