# Test Plan

> Phased test rollout for this project. Strategy is frozen at the top
> (§1–§5); cookbook patterns at the bottom (§6) fill in as phases ship.
> Read before writing any new test.
>
> Refresh: re-run `/10x-test-plan --refresh` when stale (see §8).
>
> Last updated: 2026-06-08 (Phase 2 complete)

## 1. Strategy

Tests follow three non-negotiable principles for this project:

1. **Cost × signal.** The cheapest test that gives a real signal for the
   risk wins. Do not promote to e2e because e2e "feels safer." Do not put a
   vision model on top of a deterministic visual diff that already catches
   the regression.
2. **User concerns are first-class evidence.** Risks anchored in "the team
   is worried about X, and the failure would surface somewhere in <area>"
   carry the same weight as PRD lines or hot-spot data.
3. **Risks are scenarios, not code locations.** This plan documents *what
   could fail* and *why we believe it's likely* — drawn from documents,
   interview, and codebase *signal* (churn, structure, test base). It does
   NOT claim to know which line owns the failure. That knowledge is
   produced by `/10x-research` during each rollout phase. If the plan and
   research disagree about where the failure lives, research is the ground
   truth.

Hot-spot scope used for likelihood weighting: `src/`, `supabase/`
(migrations, seed, config). Excludes `node_modules`, `dist`, `.astro`,
lockfiles, snapshots, and generated `src/db/database.types.ts`.

## 2. Risk Map

The top failure scenarios this project must protect against, ordered by
risk = impact × likelihood. Risks are failure scenarios in user / business
terms, not test names. The Source column cites the *evidence that surfaced
this risk* — never a specific file as "where the failure lives" (that is
research's job, see §1 principle #3).

| # | Risk (failure scenario) | Impact | Likelihood | Source (evidence — not anchor) |
|---|--------------------------|--------|------------|--------------------------------|
| 1 | A participant's (or the admin's) prediction is visible to anyone else before that match's kickoff | High | High | PRD FR-015 + Success-Criteria integrity invariant; interview Q1, Q3; hot-spot dir `src/db` (6 commits/30d) |
| 2 | Points are computed wrong for a (prediction, result) pair, or a result correction fails to recompute affected scores | High | High | PRD FR-018 / FR-010 + Success-Criteria scoring guardrail; interview Q4; roadmap S-04 (next slice) |
| 3 | One participant creates, edits, or deletes another participant's prediction (ownership / IDOR) | High | High | PRD FR-013 / FR-015; interview Q1, Q3; hot-spot dir `src/actions` (5 commits/30d), `src/db` |
| 4 | A prediction is created or edited after its match's kickoff (kickoff-lock bypass) | High | Medium | PRD FR-014; hot-spot dir `src/lib` (14 commits/30d); interview Q1 |
| 5 | The service-role client or a misscoped server action bypasses RLS and exposes predictions | High | Medium | roadmap S-01 risk note; AGENTS.md service-role guard; lessons.md |
| 6 | RLS / migration verified locally behaves differently against the deployed DB (silent leak or regression in prod) | High | Medium | interview Q2; AGENTS.md deploy / migration notes |
| 7 | The leaderboard ranks participants wrongly — wrong totals or wrong tie-break order | Medium | Medium | PRD FR-020; roadmap S-04 |

**Impact × Likelihood rubric.** Both axes scored High / Medium / Low so two
readers agree on the same row.

| Rating | Impact | Likelihood |
|--------|--------|------------|
| High   | user loses access, data, or money; failure publicly visible | area changes weekly, or we have already been burned here |
| Medium | feature degrades, a workaround exists, only some users affected | touched occasionally, has been a source of bugs |
| Low    | cosmetic, easily reverted, no data effect | stable code, rarely touched |

High × High protected first (#1, #2, #3). Risk #6 is a High-impact parity
concern best caught by a CI gate plus pre-prod smoke rather than a single
unit test — see §3 Phase 4 and §5.

**Abuse / security lens.** BetCup has auth and accepts user input, so the
map carries abuse rows: #1 (pre-kickoff leak), #3 (IDOR / ownership), #5
(RLS bypass via service-role). Untrusted-input parity (negative or
non-integer scores) is folded into the "Must challenge" cells of #2/#3
rather than a separate row, because zod schemas already carry partial
coverage.

### Risk Response Guidance

| Risk | What would prove protection | Must challenge | Context `/10x-research` must ground | Likely cheapest layer | Anti-pattern to avoid |
|------|------------------------------|----------------|--------------------------------------|-----------------------|-----------------------|
| #1 | A non-predictor's row-fetch for an un-kicked match returns zero prediction values; after kickoff the values become visible to all | "UI hides it" is not "DB withholds it"; the admin is NOT exempt from blindness | Where blindness is enforced (RLS `SELECT` predicate) and how `now()` evaluates per-row at fetch time | integration (RLS vs live Supabase) | asserting UI state instead of the actual row-fetch; testing only the predictor's own view |
| #2 | 5/3/2/0 correct across the full prediction×result grid incl. draws and negative goal-difference; a corrected result re-scores every affected prediction | "request returned 200 / 'saved'" is not "scores recomputed"; exact-score must also satisfy the outcome branch | Whether scoring lives in TS or a Postgres view; where a result correction triggers recompute | unit (pure fn) if scoring is extractable, else DB-level | oracle copied from the implementation under test; happy-path single pair only |
| #3 | Acting as participant A cannot mutate B's prediction; the server rejects a spoofed owner id and trusts only the session identity | "logged in" is not "owns this row"; a client-supplied owner id must never be trusted | Where ownership is checked (server action vs RLS) and what column identifies the owner | integration (RLS + action) | over-mocking the auth/session context; testing only the legitimate-owner path |
| #4 | Create/edit is rejected once kickoff has passed; the cutoff uses the server clock, not the client's | the client clock must not be trusted; off-by-one at the exact kickoff second | Which clock is the source of truth and where the cutoff is enforced (DB vs API) | integration (+ unit on the time helper) | freezing time so the kickoff boundary is never actually crossed in the test |
| #5 | Service-role usage is confined to participant creation and never reads predictions | "only one importer today" can silently stop being true | Which Supabase client each action uses and the service-role blast radius | integration + isolation assertion | grep-across-`src` false positives — assert production reads / importer count (per lessons.md) |
| #6 | RLS and scoring tests run against a real Postgres in CI, not only a dev machine | "passes locally" is not "safe in prod" | How CI can stand up an ephemeral Supabase and which migrations gate deploy | quality gate (CI) + pre-prod smoke | a parity claim with no automated gate behind it |
| #7 | Ranking follows total → exact-score count → alphabetical-by-name deterministically, including genuine tie cases | a stable sort is assumed; name tie-break must be case-insensitive | Where ranking / tie-break is computed (SQL vs TS) | unit (ranking fn) or DB-level | a snapshot of one leaderboard with no actual ties exercised |

## 3. Phased Rollout

Each row is a discrete rollout phase that will open its own change folder
via `/10x-new`. Status moves left-to-right through the values below; the
orchestrator updates Status as artifacts appear on disk.

| # | Phase name | Goal (one line) | Risks covered | Test types | Status | Change folder |
|---|------------|-----------------|----------------|------------|--------|---------------|
| 1 | Scoring & ranking correctness | Pin FR-018 grid, recompute-on-correction, and tie-break order at the cheapest layer | #2, #7 | unit (or DB-level if scoring is SQL) | complete | context/changes/testing-scoring/ |
| 2 | Blindness & ownership at the DB boundary | Prove predictions are withheld before kickoff and only the owner can mutate them | #1, #3, #5 | integration (RLS vs live Supabase) | complete | context/changes/testing-blindness-ownership/ |
| 3 | Kickoff-lock & action mutations | Lock holds at the server; result entry is admin-only; correction recomputes | #4, #3 | integration around `src/actions` | not started | — |
| 4 | Full-flow + CI parity gates | One predict→kickoff→result→leaderboard path; RLS/scoring tests gated in CI against real Postgres | #6, cross-cutting | e2e + gates | not started | — |

**Status vocabulary** (fixed — parser literals): `not started` → `change
opened` → `researched` → `planned` → `implementing` → `complete`.

Order rationale: scoring (Phase 1) has zero coverage, is a Success-Criteria
guardrail, and directly serves the in-flight S-04 — and it is the cheapest
(pure-logic) win. Blindness/ownership (Phase 2) is the pool-nullifying
invariant and extends the existing `src/db/predictions.rls.test.ts`
foothold. Kickoff-lock + actions (Phase 3) hardens the largest, least-tested
file. Full-flow + gates (Phase 4) locks the floor and closes the local↔prod
parity gap from interview Q2.

## 4. Stack

The classic test base for this project. AI-native tools (if any) carry a
`checked:` date so future readers can see which lines need re-verification.

| Layer | Tool | Version | Notes |
|-------|------|---------|-------|
| unit + integration | Vitest | ^4.1.7 | `npm test` = `vitest run`; `happy-dom` env; `@/*` alias mirrored; Astro virtual modules stubbed in `test/stubs/` |
| coverage | @vitest/coverage-v8 | ^4.1.7 | installed; not yet wired as a gate |
| DB / RLS | Supabase CLI (local stack) | ^2.23.4 | `src/db/*.rls.test.ts` run against the local Supabase Postgres; require `npx supabase start` |
| API mocking | none yet | — | actions exercised directly via stubs; revisit only if an external HTTP edge appears |
| e2e | none yet — see Phase 4 | — | candidate: cursor-ide-browser MCP / Playwright; add only if a failure mode needs the full deployed shape |
| accessibility | none | — | out of scope for the current rollout |
| (optional) AI-native | none yet | n/a | no current need under cost × signal; revisit at `--refresh` |

**Stack grounding tools (current session):**
- Docs: Context7 — available; use for current Astro Actions, Supabase RLS, and Vitest 4 APIs before recommending test scaffolding; checked: 2026-06-04
- Search: Exa — available; use only to confirm current status of any e2e / AI-native tool before adoption; checked: 2026-06-04
- Runtime/browser: cursor-ide-browser MCP — available; possible Phase 4 e2e/visual layer, but prefer cheaper deterministic tests; checked: 2026-06-04
- Provider/platform: no GitHub / Supabase / Cloudflare MCP exposed this session (Atlassian only); CI-gate notes rely on the existing `.github/workflows/ci.yml`; checked: 2026-06-04

## 5. Quality Gates

The full set of gates that must pass before a change reaches production.
"Required for §3 Phase N" means the gate is enforced once that rollout phase
lands; before that, the gate is `planned`.

| Gate | Where | Required? | Catches |
|------|-------|-----------|---------|
| lint + typecheck | local + CI | required (existing CI) | syntactic / type drift |
| check:wrangler | pre-commit + CI | required (existing CI) | removal of `nodejs_compat` flag that breaks Supabase SSR |
| unit + integration | local + CI | required after §3 Phase 1 | scoring / ranking / logic regressions |
| RLS tests vs real Postgres | CI | required (active since §3 Phase 2) | blindness / ownership / service-role leaks |
| e2e on the critical flow | CI on PR | planned — §3 Phase 4 | broken predict→result→leaderboard path |
| pre-prod smoke | between merge + prod | planned — §3 Phase 4 | local↔deployed-DB divergence (Risk #6) |
| visual / snapshot | — | excluded (see §7) | n/a |

## 6. Cookbook Patterns

How to add new tests in this project. Each sub-section is filled in once the
relevant rollout phase ships; before that, the sub-section reads "TBD — see
§3 Phase N."

### 6.1 Adding a unit test

- **Location**: next to the unit under test (e.g. `src/lib/<mod>.test.ts`),
  matching the existing convention.
- **Reference test**: `src/lib/time.test.ts`, `src/lib/bulk-parse.test.ts`.
- **Run locally**: `npm test`.
- **Scoring/ranking specifics**: TBD — see §3 Phase 1 for the FR-018
  grid + recompute + tie-break pattern (Risk #2, #7).

### 6.2 Adding an integration / RLS test

- **Location**: `src/db/<table>.rls.test.ts`.
- **Mocking policy**: do NOT mock the DB — RLS tests run against the local
  Supabase Postgres (`npx supabase start`). Mock only true external edges.
- **Reference test**: `src/db/predictions.rls.test.ts`,
  `src/db/matches.rls.test.ts`.
- **Run locally**: `npm test` with the local Supabase stack up.
- **Blindness/ownership specifics** (Phase 2 — Risk #1, #3, #5): predictions
  combine two test shapes in one file (`src/db/predictions.rls.test.ts`):
  1. **Live-DB RLS cases** inside the `describe.skipIf(!dbConfigured)` block —
     reuse the shared `beforeAll` fixtures (`participantA`/`participantB`/`admin`/
     `service`, a future + past match, A's seeded predictions). Idioms:
     - *blindness* (#1): a non-owner `.select(...).eq("match_id", future)` —
       with OR without the owner filter — → `expect(error).toBeNull(); expect(data ?? []).toHaveLength(0)`.
     - *spoofed-owner INSERT* (#3): as B, `insert({ predictor_id: aUserId, … })`
       → `expect(error).not.toBeNull()` (RLS WITH CHECK `predictor_id = auth.uid()`).
     - *cross-owner UPDATE / DELETE* (#3): as B, target A's row → `error` null,
       `data` zero rows. NOTE these are **double-guarded**: the SELECT/blindness
       policy gates row-finding for UPDATE/DELETE, so B cannot even locate A's
       pre-kickoff row. To watch a DELETE/UPDATE test fail "for the right reason"
       you must ALSO relax `predictions_select` (proven during Phase 2 verification).
     - *anon denial* (#1): an anon-key client with no sign-in → zero rows (the
       policy is `to authenticated` only).
     - *near-boundary crossing* (#1): seed a match ~3s out, A predicts pre-kickoff,
       assert B blind, then **poll** until past kickoff (never a fixed sleep) and
       assert reveal on the same row; wrap in one `it(…, 20000)`.
  2. **Static isolation guard** (#5) in a top-level, **non-skip-gated**
     `describe` so it runs in the default `ci` job (no DB) — exactly where
     catching a new service-role importer matters most. Read raw production
     source via `import.meta.glob("/src/**/*.{ts,tsx,astro}", { query: "?raw",
     import: "default", eager: true })`, exclude `*.test.*` and `test/`, then
     assert **counts** (per lessons.md, never a raw `rg` across `src` — test
     harnesses reference the key name): exactly one reader of
     `SUPABASE_SERVICE_ROLE_KEY` via `astro:env/server` (`supabase-admin.ts`),
     exactly one importer of the admin client (`actions/index.ts`), and no
     `.from(` on `supabase-admin.ts` (auth-only, RLS-bypassing client).

### 6.3 Adding an action-layer test

- TBD — see §3 Phase 3 (kickoff-lock + admin-only result entry). Current
  reference: `src/actions/participants.test.ts`.

### 6.4 Adding an e2e test

- TBD — see §3 Phase 4 (predict→kickoff→result→leaderboard happy path).

### 6.5 Wiring a CI quality gate

- TBD — see §3 Phase 4 (RLS + scoring tests against ephemeral Postgres;
  pre-prod smoke for Risk #6).

### 6.6 Per-rollout-phase notes

(Filled in by `/10x-implement` as each phase lands.)

- **Phase 2 — Blindness & ownership at the DB boundary (2026-06-08)** —
  extended `src/db/predictions.rls.test.ts` with 6 live-DB RLS cases (#1/#3:
  spoofed-owner INSERT, cross-owner UPDATE/DELETE, unfiltered-list blindness,
  anon denial, near-boundary kickoff crossing) plus a static, no-DB
  service-role isolation guard (#5). Pattern is documented in §6.2. No
  production code or RLS policy changed — the enforcement already existed; the
  phase pins it.
  - **Known pre-existing issue (NOT introduced by this phase), tracked here:**
    `npm test -- rls` currently fails in `src/db/results-scoring.rls.test.ts`
    (Phase 1 file, untouched by Phase 2). The installed
    `@supabase/supabase-js` (2.105.3, declared `^2.99.1`) breaks realtime
    WebSocket construction inside that file's `@vitest-environment node`
    context (`getWebSocketConstructor` throws at client init). `predictions.rls`
    runs under `happy-dom` (provides `WebSocket`) and is unaffected — 18/18
    green. Fix candidates for a future change: pin/align the supabase-js
    version, or give the node-env RLS files a `ws` transport stub. Open a
    dedicated change (`/10x-new`) rather than folding it into this rollout.

## 7. What We Deliberately Don't Test

Exclusions agreed during the rollout (Phase 2 interview, Q5). Future
contributors should respect these unless the underlying assumption changes.

- **Visual / snapshot tests for static Astro pages** — they break
  constantly and catch nothing of value. Re-evaluate only if a rendering
  regression actually ships to users. (Source: Phase 2 interview Q5.)
- **shadcn/ui primitives in `src/components/ui/`** — vendored via
  `npx shadcn@latest add`; the generator is the test. (Source: AGENTS.md
  hard rule + Q5 intent.)

## 8. Freshness Ledger

- Strategy (§1–§5) last reviewed: 2026-06-04
- Stack versions last verified: 2026-06-04
- AI-native tool references last verified: 2026-06-04

Refresh (`/10x-test-plan --refresh`) when:

- a new top-3 risk surfaces from the roadmap or archive,
- a recommended tool's `checked:` date is older than three months,
- the project's tech stack changes (new framework, new test runner),
- §7 negative-space no longer matches what the team believes.
