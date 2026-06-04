<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Admin Creates Participants (S-01)

- **Plan**: context/changes/admin-creates-participants/plan.md
- **Mode**: Deep
- **Date**: 2026-06-03
- **Verdict**: REVISE
- **Findings**: 1 critical, 2 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | WARNING |
| Architectural Fitness | PASS |
| Blind Spots | WARNING |
| Plan Completeness | FAIL |

## Grounding

12/12 paths ✓, key symbols ✓ (handle_new_user, adminClient/internalError, ADMIN_ROUTES, profiles_select RLS, matches.rls live-DB harness), brief↔plan ✓, contract-surfaces.md absent (skipped). The existing `src/db/matches.rls.test.ts` live-DB harness already exercises `auth.admin.createUser` → `signInWithPassword`, proving this slice's core mechanism. The implemented S-02 plan used plain `-` bullets in phase Success Criteria (basis of F1).

## Findings

### F1 — Phase Success Criteria use checkboxes, not plain bullets

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phases 1–4, "#### Automated/Manual Verification"
- **Detail**: Every phase's Success Criteria bullets are `- [ ]` checkboxes (e.g. lines 107–117), duplicating the canonical `## Progress` steps. The progress-format contract parses "next pending step = first `- [ ]` in document order" — these un-indexed phase checkboxes appear before the Progress section, so a whole-document scan hits a Success-Criteria box (line 107) instead of Progress step 1.1 (line 398). The implemented S-02 plan used plain `-` bullets in phase bodies and `- [ ]` only in Progress; this plan breaks that convention. The `## Progress` section itself is well-formed and complete.
- **Fix**: Convert every phase `#### Automated/Manual Verification` bullet from `- [ ]` to plain `- `. Leave `## Progress` untouched — it already holds the indexed checkboxes.
- **Decision**: FIXED (converted all phase Success-Criteria checkboxes to plain bullets)

### F2 — Admin's own row appears in the participant list

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 3 §3 (participants.astro query)
- **Detail**: The page query is `from("profiles").select("display_name, username").order("created_at")` with no role/self filter. Under `profiles_select` the admin reads ALL rows, so the admin's own profile (username `admin`) renders inside a list labelled "existing participants". The admin holds the participant role (FR-017) so it's not strictly wrong, but the plan never addresses who appears — and S-06 will hang a delete control off these rows (deleting the admin row would be a footgun).
- **Fix**: Exclude the admin from the list — filter to participant-role rows that aren't the current admin (join user_roles, or `.neq("id", Astro.locals.user.id)`). If intentional, state it in the plan and add a guard so S-06's delete can't target admin.
- **Decision**: FIXED (added `.neq("id", Astro.locals.user.id)` to the page query + rationale)

### F3 — Duplicate detection rests on an unverified GoTrue error shape

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Critical Impl Details (dup detection) + Phase 2 §6 step 5
- **Detail**: The "That username is taken" criterion depends on mapping `error.code === "email_exists"` or status 422 from `auth.admin.createUser`, but the plan only hedges ("e.g."). If the real shape differs, duplicates fall through to the generic internalError and the friendly-error success criterion silently fails. Layering subtlety: because username↔email is 1:1, a true dup trips email_exists before the trigger runs; the `profiles_username_lower_idx` unique index would only surface (as a different, 500-shaped error) in edge cases where a stored username diverges from its email local-part.
- **Fix**: Confirm the exact error contract once against the local stack (trivial via the existing matches.rls harness — log the error object), pin the literal in the handler, and assert it in the Phase 4 duplicate test so a GoTrue change can't regress it silently.
  - Strength: Turns a guessed branch into a test-pinned contract.
  - Tradeoff: ~15 min of local spelunking before coding the branch.
  - Confidence: HIGH — the harness already runs admin.createUser locally.
  - Blind spot: Hosted-Supabase error shape may differ from local; worth a deploy-time recheck.
- **Decision**: FIXED (added confirm-and-pin step to Critical Impl Details + Phase 2 §6.5; Phase 4 dup test now pins the contract)

### F4 — Trigger metadata-username branch isn't lowercased

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §1 step 6 (handle_new_user contract)
- **Detail**: Prose says username is written "lowercased", but the SQL `coalesce(nullif(meta->>'username',''), lower(split_part(email,'@',1)))` only lowercases the email-fallback branch. The Action path is safe (zod `.toLowerCase()`), but the Studio "Add user" path (manual verify 1.6) would store mixed case — display vs. login-resolved case then diverge.
- **Fix**: Wrap the metadata branch: `lower(coalesce(nullif(meta->>'username',''), split_part(email,'@',1)))`.
- **Decision**: FIXED (lower() now wraps the whole coalesce in the trigger contract)

### F5 — Ambiguous admin-guard reuse in the Action

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Lean Execution
- **Location**: Phase 2 §6 step 1
- **Detail**: "Reuses the admin check (extract the role check from adminClient or call it)" leaves a fork. Calling `adminClient(context)` builds an anon SSR client this Action never uses (it writes nothing via the anon client). Leaving the choice to the implementer invites an unused-client smell.
- **Fix**: Extract a `requireAdmin(locals)` guard from adminClient and call it from both adminClient and participants.create.
- **Decision**: FIXED (Phase 2 §6.1 now specifies a shared requireAdmin guard; forbids unused adminClient)
