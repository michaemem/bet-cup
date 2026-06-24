# Test Plan

> Phased test rollout for this project. Strategy is frozen at the top
> (§1–§5); cookbook patterns at the bottom (§6) fill in as phases ship.
> Read before writing any new test.
>
> Refresh: re-run `/10x-test-plan --refresh` when stale (see §8).
>
> Last updated: 2026-06-24 (added Risk #8 prediction-persistence + the E2E seed
> exemplar `tests/e2e/seed.spec.ts`; Phase 4 e2e infra still pending)

## 1. Strategy

Tests follow three non-negotiable principles for this project:

1. **Cost × signal.** The cheapest test that gives a real signal for the
   risk wins. Do not promote to e2e because e2e "feels safer." Do not put a
   vision model on top of a deterministic visual diff that already catches
   the regression.
2. **User concerns are first-class evidence.** Risks anchored in "the team
   is worried about X, and the failure would surface somewhere in <area>"
   carry the same weight as PRD lines or hot-spot data.
3. **Risks are scenarios, not code locations.** This plan documents _what
   could fail_ and _why we believe it's likely_ — drawn from documents,
   interview, and codebase _signal_ (churn, structure, test base). It does
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
terms, not test names. The Source column cites the _evidence that surfaced
this risk_ — never a specific file as "where the failure lives" (that is
research's job, see §1 principle #3).

| #   | Risk (failure scenario)                                                                                                                   | Impact | Likelihood | Source (evidence — not anchor)                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------ | ---------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | A participant's (or the admin's) prediction is visible to anyone else before that match's kickoff                                         | High   | High       | PRD FR-015 + Success-Criteria integrity invariant; interview Q1, Q3; hot-spot dir `src/db` (6 commits/30d)      |
| 2   | Points are computed wrong for a (prediction, result) pair, or a result correction fails to recompute affected scores                      | High   | High       | PRD FR-018 / FR-010 + Success-Criteria scoring guardrail; interview Q4; roadmap S-04 (next slice)               |
| 3   | One participant creates, edits, or deletes another participant's prediction (ownership / IDOR)                                            | High   | High       | PRD FR-013 / FR-015; interview Q1, Q3; hot-spot dir `src/actions` (5 commits/30d), `src/db`                     |
| 4   | A prediction is created or edited after its match's kickoff (kickoff-lock bypass)                                                         | High   | Medium     | PRD FR-014; hot-spot dir `src/lib` (14 commits/30d); interview Q1                                               |
| 5   | The service-role client or a misscoped server action bypasses RLS and exposes predictions                                                 | High   | Medium     | roadmap S-01 risk note; AGENTS.md service-role guard; lessons.md                                                |
| 6   | RLS / migration verified locally behaves differently against the deployed DB (silent leak or regression in prod)                          | High   | Medium     | interview Q2; AGENTS.md deploy / migration notes                                                                |
| 7   | The leaderboard ranks participants wrongly — wrong totals or wrong tie-break order                                                        | Medium | Medium     | PRD FR-020; roadmap S-04                                                                                        |
| 8   | A participant's saved prediction is lost or shown stale after a page reload / navigation (the score doesn't survive a real SSR re-render) | Medium | Low        | PRD predict flow; `PredictionForm` reload-on-success pattern; roadmap Phase 4 full-flow (predict→…→leaderboard) |

**Impact × Likelihood rubric.** Both axes scored High / Medium / Low so two
readers agree on the same row.

| Rating | Impact                                                          | Likelihood                                               |
| ------ | --------------------------------------------------------------- | -------------------------------------------------------- |
| High   | user loses access, data, or money; failure publicly visible     | area changes weekly, or we have already been burned here |
| Medium | feature degrades, a workaround exists, only some users affected | touched occasionally, has been a source of bugs          |
| Low    | cosmetic, easily reverted, no data effect                       | stable code, rarely touched                              |

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

| Risk | What would prove protection                                                                                                                                                                                                                                                    | Must challenge                                                                                                                                                                                           | Context `/10x-research` must ground                                                                                                                                               | Likely cheapest layer                                                                                    | Anti-pattern to avoid                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| #1   | A non-predictor's row-fetch for an un-kicked match returns zero prediction values; after kickoff the values become visible to all                                                                                                                                              | "UI hides it" is not "DB withholds it"; the admin is NOT exempt from blindness                                                                                                                           | Where blindness is enforced (RLS `SELECT` predicate) and how `now()` evaluates per-row at fetch time                                                                              | integration (RLS vs live Supabase)                                                                       | asserting UI state instead of the actual row-fetch; testing only the predictor's own view                                           |
| #2   | 5/3/2/0 correct across the full prediction×result grid incl. draws and negative goal-difference; a corrected result re-scores every affected prediction                                                                                                                        | "request returned 200 / 'saved'" is not "scores recomputed"; exact-score must also satisfy the outcome branch                                                                                            | Whether scoring lives in TS or a Postgres view; where a result correction triggers recompute                                                                                      | unit (pure fn) if scoring is extractable, else DB-level                                                  | oracle copied from the implementation under test; happy-path single pair only                                                       |
| #3   | At the DB layer: a spoofed owner id is rejected. At the action layer: the upsert exposes no owner channel — `predictor_id` is the session identity and the write is scoped to the caller's own row                                                                             | "logged in" is not "owns this row"; at the action layer there is nothing to spoof (the schema has no owner field), so don't write a "spoof rejected" action test — that belongs to RLS (already covered) | Where ownership is enforced (RLS spoof-rejection vs action session-derivation) and that the action input carries no owner field                                                   | DB-layer spoof/cross-owner = RLS (shipped Phase 2); action-layer = integration asserting caller-scoping  | over-mocking the auth/session context; testing only the legitimate-owner path; re-asserting RLS spoof-rejection at the action layer |
| #4   | Create/edit is rejected once kickoff has passed, using a server clock not the client's. Note two server clocks: the action pre-check uses Node `Date.now()` (advisory, friendly message); the authoritative lock is Postgres `now()` via RLS, surfaced as zero-row → FORBIDDEN | the client clock must not be trusted; off-by-one at the exact kickoff second; the action's own `Date.now()` pre-check is NOT the race-proof lock — the RLS zero-row is                                   | Which clock is authoritative (Postgres `now()` in RLS) vs advisory (action pre-check), and how the handler translates each (NOT_FOUND vs PREDICTION_LOCKED vs zero-row→FORBIDDEN) | DB lock = RLS (shipped); action-layer = integration asserting the handler's message/zero-row translation | re-proving the DB clock at the action layer; freezing time so the kickoff boundary is never actually crossed in the test            |
| #5   | Service-role usage is confined to participant creation and never reads predictions                                                                                                                                                                                             | "only one importer today" can silently stop being true                                                                                                                                                   | Which Supabase client each action uses and the service-role blast radius                                                                                                          | integration + isolation assertion                                                                        | grep-across-`src` false positives — assert production reads / importer count (per lessons.md)                                       |
| #6   | RLS and scoring tests run against a real Postgres in CI, not only a dev machine                                                                                                                                                                                                | "passes locally" is not "safe in prod"                                                                                                                                                                   | How CI can stand up an ephemeral Supabase and which migrations gate deploy                                                                                                        | quality gate (CI) + pre-prod smoke                                                                       | a parity claim with no automated gate behind it                                                                                     |
| #7   | Ranking follows total → exact-score count → alphabetical-by-name deterministically, including genuine tie cases                                                                                                                                                                | a stable sort is assumed; name tie-break must be case-insensitive                                                                                                                                        | Where ranking / tie-break is computed (SQL vs TS)                                                                                                                                 | unit (ranking fn) or DB-level                                                                            | a snapshot of one leaderboard with no actual ties exercised                                                                         |
| #8   | A participant enters a score, and after a real page reload the SAME score is still rendered (persisted to the DB and re-read by the SSR surface), not lost or reset to the default                                                                                             | "the form said saved" is not "the row survives a reload"; the post-save in-memory state is not the SSR-re-read state                                                                                     | That `predictions.upsert` writes the row and `/predictions` re-queries it on every SSR render (no client-only cache masking a lost write)                                         | e2e (the only layer that exercises submit → real reload → SSR re-read end-to-end)                        | asserting the in-memory form value right after submit instead of re-reading after a real `page.reload()`; using `waitForTimeout`    |

## 3. Phased Rollout

Each row is a discrete rollout phase that will open its own change folder
via `/10x-new`. Status moves left-to-right through the values below; the
orchestrator updates Status as artifacts appear on disk.

| #   | Phase name                               | Goal (one line)                                                                                  | Risks covered     | Test types                           | Status      | Change folder                                 |
| --- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------ | ----------- | --------------------------------------------- |
| 1   | Scoring & ranking correctness            | Pin FR-018 grid, recompute-on-correction, and tie-break order at the cheapest layer              | #2, #7            | unit (or DB-level if scoring is SQL) | complete    | context/changes/testing-scoring/              |
| 2   | Blindness & ownership at the DB boundary | Prove predictions are withheld before kickoff and only the owner can mutate them                 | #1, #3, #5        | integration (RLS vs live Supabase)   | complete    | context/changes/testing-blindness-ownership/  |
| 3   | Kickoff-lock & action mutations          | Lock holds at the server; result entry is admin-only; correction recomputes                      | #4, #3            | integration around `src/actions`     | complete    | context/changes/testing-kickoff-lock-actions/ |
| 4   | Full-flow + CI parity gates              | One predict→kickoff→result→leaderboard path; RLS/scoring tests gated in CI against real Postgres | #6, cross-cutting | e2e + gates                          | not started | —                                             |

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

| Layer                | Tool                       | Version | Notes                                                                                                            |
| -------------------- | -------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| unit + integration   | Vitest                     | ^4.1.7  | `npm test` = `vitest run`; `happy-dom` env; `@/*` alias mirrored; Astro virtual modules stubbed in `test/stubs/` |
| coverage             | @vitest/coverage-v8        | ^4.1.7  | installed; not yet wired as a gate                                                                               |
| DB / RLS             | Supabase CLI (local stack) | ^2.23.4 | `src/db/*.rls.test.ts` run against the local Supabase Postgres; require `npx supabase start`                     |
| API mocking          | none yet                   | —       | actions exercised directly via stubs; revisit only if an external HTTP edge appears                              |
| e2e                  | none yet — see Phase 4     | —       | candidate: cursor-ide-browser MCP / Playwright; add only if a failure mode needs the full deployed shape         |
| accessibility        | none                       | —       | out of scope for the current rollout                                                                             |
| (optional) AI-native | none yet                   | n/a     | no current need under cost × signal; revisit at `--refresh`                                                      |

**Stack grounding tools (current session):**

- Docs: Context7 — available; use for current Astro Actions, Supabase RLS, and Vitest 4 APIs before recommending test scaffolding; checked: 2026-06-04
- Search: Exa — available; use only to confirm current status of any e2e / AI-native tool before adoption; checked: 2026-06-04
- Runtime/browser: cursor-ide-browser MCP — available; possible Phase 4 e2e/visual layer, but prefer cheaper deterministic tests; checked: 2026-06-04
- Provider/platform: no GitHub / Supabase / Cloudflare MCP exposed this session (Atlassian only); CI-gate notes rely on the existing `.github/workflows/ci.yml`; checked: 2026-06-04

## 5. Quality Gates

The full set of gates that must pass before a change reaches production.
"Required for §3 Phase N" means the gate is enforced once that rollout phase
lands; before that, the gate is `planned`.

| Gate                       | Where                | Required?                          | Catches                                                  |
| -------------------------- | -------------------- | ---------------------------------- | -------------------------------------------------------- |
| lint + typecheck           | local + CI           | required (existing CI)             | syntactic / type drift                                   |
| check:wrangler             | pre-commit + CI      | required (existing CI)             | removal of `nodejs_compat` flag that breaks Supabase SSR |
| unit + integration         | local + CI           | required after §3 Phase 1          | scoring / ranking / logic regressions                    |
| RLS tests vs real Postgres | CI                   | required (active since §3 Phase 2) | blindness / ownership / service-role leaks               |
| e2e on the critical flow   | CI on PR             | planned — §3 Phase 4               | broken predict→result→leaderboard path                   |
| pre-prod smoke             | between merge + prod | planned — §3 Phase 4               | local↔deployed-DB divergence (Risk #6)                   |
| visual / snapshot          | —                    | excluded (see §7)                  | n/a                                                      |

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
     - _blindness_ (#1): a non-owner `.select(...).eq("match_id", future)` —
       with OR without the owner filter — → `expect(error).toBeNull(); expect(data ?? []).toHaveLength(0)`.
     - _spoofed-owner INSERT_ (#3): as B, `insert({ predictor_id: aUserId, … })`
       → `expect(error).not.toBeNull()` (RLS WITH CHECK `predictor_id = auth.uid()`).
     - _cross-owner UPDATE / DELETE_ (#3): as B, target A's row → `error` null,
       `data` zero rows. NOTE these are **double-guarded**: the SELECT/blindness
       policy gates row-finding for UPDATE/DELETE, so B cannot even locate A's
       pre-kickoff row. To watch a DELETE/UPDATE test fail "for the right reason"
       you must ALSO relax `predictions_select` (proven during Phase 2 verification).
     - _anon denial_ (#1): an anon-key client with no sign-in → zero rows (the
       policy is `to authenticated` only).
     - _near-boundary crossing_ (#1): seed a match ~3s out, A predicts pre-kickoff,
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

- **Location**: next to the action surface, `src/actions/<surface>.test.ts`.
- **Reference test**: `src/actions/predictions.test.ts` (kickoff-lock +
  caller-scoping), `src/actions/account.test.ts` (the live-DB session/cookie
  builder), `src/actions/results.test.ts` (the always-runs guard idiom).
- **Run locally**: `npm test` (always-runs lane); add the four `SUPABASE_*` env
  vars with the local stack up for the live lane (`npm test -- predictions`).
- **Pattern** (Phase 3 — Risk #3, #4): exercise the REAL handler, two lanes.
  1. **Reach the handler.** `astro:actions`/`astro:env/server` are virtual
     modules aliased to `test/stubs/*` (`defineAction` is identity), so
     `const { server } = await import("@/actions/index")` resolves and the
     config — including `handler` — is reachable:
     `(server.<surface>.<action> as unknown as { handler }).handler`. Validate
     input with the action's zod schema `.parse(...)` before calling (the stub
     does not run `input` validation for you).
  2. **NO `@vitest-environment` pragma** — stay on the global `happy-dom` env.
     supabase-js (2.105.3) throws on client init under `@vitest-environment
node` (WebSocket; see §6.6), and `happy-dom` provides `WebSocket`.
  3. **Always-runs lane** — a plain top-level `describe` proving the auth guard:
     call the handler with `locals.user` absent → rejects with code
     `UNAUTHORIZED` before any DB call. This runs in the default DB-free
     `npm test` / CI gate, so the guard never silently regresses.
  4. **Live-DB lane** — `describe.skipIf(!dbConfigured)` with `dbConfigured =
Boolean(SUPABASE_DB_URL && ANON_KEY && SERVICE_ROLE_KEY)`. Inline (house
     style — no shared helper) a `cookieStub()` and an `authedContext(email,
password)` builder: sign in on a `@supabase/ssr` `createServerClient`
     backed by an in-memory cookie jar, then serialize the jar into a `Cookie`
     header via a **plain** `{ headers: { get } }` request stub — happy-dom's
     `Headers` strips the forbidden `Cookie` header, which would silently leave
     the handler's client unauthenticated. `beforeAll` seeds via service-role +
     an admin session (tournament, future + past matches; a post-kickoff row is
     seeded service-role to bypass the INSERT lock); `afterAll` cascades the
     tournament and deletes the auth users.
  5. **Assert error code + which branch fired** (`UNAUTHORIZED` /
     `NOT_FOUND` / `FORBIDDEN`), never the message text (messages are UX, not
     contract) and never the Postgres `error.code`. For the kickoff lock (#4),
     a post-kickoff create/edit → `FORBIDDEN` (the RLS zero-row guard), an
     unknown match id → `NOT_FOUND`. For ownership (#3), there is **no owner
     channel** in the input schema, so assert caller-scoping (acting as B writes
     B's own row; A's row is byte-for-byte unchanged) rather than re-proving the
     RLS spoof-rejection — that lives in `src/db/predictions.rls.test.ts`.

### 6.4 Adding an e2e test

- **Location**: project-level e2e dir, `tests/e2e/<feature>.spec.ts`, one test
  per file.
- **Seed / reference test**: `tests/e2e/seed.spec.ts` — the exemplar every
  generated E2E test is modeled on (Risk #8: a participant's own prediction
  persists across a real SSR reload). It demonstrates the five conventions:
  `getByRole` as the default selector, wait-for-state (post-login
  `waitForURL`, the `Save`→`Update` flip) never wait-for-time, unique per-run
  test data, owner-scoped cleanup, and a name bound to a `test-plan.md` risk.
  _What the seed shows is what generated tests inherit_ — keep it clean.
- **Run locally**: requires the running app (`npm run dev`) + a Playwright
  config with `baseURL`, and a seeded participant + a future match (see the
  spec's provenance header for the env knobs). Playwright is **not yet
  installed** — wiring it up is Phase 4 (see §3, §6.5).
- **Full predict→kickoff→result→leaderboard happy path + CI gate**: TBD — see
  §3 Phase 4.

### 6.5 Wiring a CI quality gate

- TBD — see §3 Phase 4 (RLS + scoring tests against ephemeral Postgres;
  pre-prod smoke for Risk #6).

### 6.6 Per-rollout-phase notes

(Filled in by `/10x-implement` as each phase lands.)

- **CI infra — pin Supabase CLI (2026-06-18, `ci-pin-supabase-cli`)** — the `rls`
  gate went red with `permission denied for table tournaments` in every suite's
  `beforeAll`. Root cause (reproduced locally, bisected on CLI version): the
  unpinned `supabase/setup-cli` (`version: latest`) pulled CLI **v2.107.0**, which
  defaults the local stack to **asymmetric ES256 JWT signing keys**. The RLS
  harness' authenticated requests aren't honored under that scheme → PostgREST
  falls back to the `anon` role → admin-only writes fail with Postgres 42501.
  **Not** an admin-seed/RLS-policy bug (the admin is correctly promoted; verified
  via direct query). Fix: pin `setup-cli` to **2.98.2** (legacy HS256) in
  `ci.yml`. This is Risk #6 (local↔CI drift) realized. **Pin lift condition:**
  update the harness to carry ES256 keys, then unpin. Local repro: `2.98.2 →
57/57`, `2.107.0 → 4 suites fail`.

- **Phase 3 — Kickoff-lock & action mutations (2026-06-18)** — added
  `src/actions/predictions.test.ts`: an always-runs `UNAUTHORIZED` guard (rides
  the default DB-free `ci` gate) plus a `skipIf(!dbConfigured)` live-DB lane
  proving the action-layer translation on top of RLS — pre-kickoff
  create/edit succeeds and is caller-scoped (#3: `predictor_id` is the session
  identity, no owner channel), post-kickoff create/edit → `FORBIDDEN` (#4 — the
  app-layer `Date.now()` pre-check fires for the long-past seeded matches; the
  RLS zero-row is the race-proof backstop, proven at the DB layer by the
  write-flip below), unknown match id → `NOT_FOUND` (distinct branch), and B's
  upsert writes B's own row while A's is untouched. Also closed the one DB-layer
  gap: `src/db/predictions.rls.test.ts` gained a near-boundary **write**-flip
  case (A's own UPDATE flips from 1 row to zero as Postgres `now()` crosses
  kickoff — polled, never a fixed sleep), complementing the existing SELECT-flip.
  Convention reinforced: assert error **code + which branch fired**
  (`UNAUTHORIZED`/`NOT_FOUND`/`FORBIDDEN`), never message text and never the
  Postgres `error.code`. Pattern documented in §6.3. No production code, schema,
  or RLS policy changed — the enforcement already existed; the phase pins it.
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
