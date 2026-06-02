# Lessons Learned

> Append-only register of recurring rules and patterns. Re-read at start by /10x-frame, /10x-research, /10x-plan, /10x-plan-review, /10x-implement, /10x-impl-review.

## Unplanned-but-benign support files in a feature diff

- **Context**: S-02 diff included `eslint.config.js`, `supabase/config.toml`, `src/components/ui/label.tsx`, and a `SECURITY_HEADERS` change in `src/middleware.ts` — none named in the plan.
- **Problem**: These files weren't in the plan's "Changes Required", so they read as scope creep during implementation review, even though each is a benign, necessary support change (lint ignores for generated/shadcn output, local Supabase auth config to enable sign-in + the RLS test, a transitive shadcn primitive pulled in by `form.tsx`, and an F-01 security hardening carry-over).
- **Rule**: _<to fill>_
- **Applies to**: _<to fill>_
