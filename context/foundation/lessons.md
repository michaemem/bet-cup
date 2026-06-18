# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Unplanned-but-benign support files in a feature diff

- **Context**: S-02 diff included `eslint.config.js`, `supabase/config.toml`, `src/components/ui/label.tsx`, and a `SECURITY_HEADERS` change in `src/middleware.ts` — none named in the plan.
- **Problem**: These files weren't in the plan's "Changes Required", so they read as scope creep during implementation review, even though each is a benign, necessary support change (lint ignores for generated/shadcn output, local Supabase auth config to enable sign-in + the RLS test, a transitive shadcn primitive pulled in by `form.tsx`, and an F-01 security hardening carry-over).
- **Rule**: _<to fill>_
- **Applies to**: _<to fill>_

## Isolation criteria should target production reads, not literal grep across src/

- **Context**: S-01 Phase 2 criterion `rg "SUPABASE_SERVICE_ROLE_KEY" src` was meant to return only `src/lib/supabase-admin.ts`. After Phase 4, it also matches `src/actions/participants.test.ts` and the pre-existing `src/db/matches.rls.test.ts`.
- **Problem**: Those test harnesses reference the secret's _name_ via `process.env` (not the production `astro:env/server` read), so a literal grep-across-`src` isolation check picks them up and reports a false softening — even though the real production invariant (one `astro:env/server` reader, one importer) still holds.
- **Rule**: Phrase secret-isolation success criteria against production reads — exclude test files (e.g. `rg --glob '!*.test.*'`) or assert the importer/reader count rather than a raw substring match across `src/`.
- **Applies to**: Any plan criterion that greps for a secret or identifier to prove isolation/single-ownership.

## Reproduce against the actual failing environment before locking a root cause

- **Context**: Any /10x-frame or debugging of an environment-specific failure where local and CI diverge (test-plan Risk #6) — especially Supabase/CLI/RLS tooling, where a symptom is reasoned about but not reproduced against the breaking version/environment.
- **Problem**: In `ci-pin-supabase-cli`, the frame locked a root cause (fragile admin-seed promotion) from the symptom + codebase structure alone, never reproducing under the breaking CLI. It was wrong — the admin was promoted fine; the real cause was an ES256 JWT signing-key default in CLI v2.107.0. A full plan and a committed seed change were built on the wrong diagnosis before live reproduction corrected it.
- **Rule**: Before locking a root cause for an environment-specific failure, reproduce it against the actual failing environment/version and bisect the changed variable. Treat symptom-only reasoning as a hypothesis, not a conclusion — capture decisive runtime evidence (e.g. the JWT `alg` header, the actual role/grant in the request) before planning a fix.
- **Applies to**: frame, research, plan, implement
