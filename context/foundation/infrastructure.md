---
project: bet-cup
researched_at: 2026-05-27
recommended_platform: Cloudflare Workers
runner_up: Fly.io
context_type: mvp
tech_stack:
  language: TypeScript
  framework: Astro 6 SSR + React 19
  runtime: Cloudflare Workers (workerd)
---

## Recommendation

**Deploy on Cloudflare Workers.**

Cloudflare Workers is the only candidate that scored 5/5 Pass against the agent-friendly criteria, costs $0/mo realistically for a 5–20 user private friend pool, and carries zero migration cost — the project was scaffolded with `@astrojs/cloudflare` v13 + Wrangler and `AGENTS.md` already documents Workers Secrets + `astro:env/server` as hard rules. Free-tier capacity (100k req/day, 10 ms CPU) sits well above expected load; a $5/mo Workers Paid upgrade is the only escape hatch needed if CPU-ms tightens.

## Platform Comparison

### Scoring matrix

| Platform | CLI-first | Managed/Serverless | Agent-readable docs | Stable deploy API | MCP / Integration | Score |
|---|---|---|---|---|---|---|
| Cloudflare Workers | Pass | Pass | Pass | Pass | Pass | **5 / 5** |
| Vercel | Pass | Pass | Pass | Pass | Pass | **5 / 5** |
| Netlify | Partial (no CLI rollback) | Pass | Pass | Pass | Pass | **4 Pass + 1 Partial** |
| Fly.io | Pass | Pass | Pass | Pass | Partial (`fly mcp` beta) | **4 Pass + 1 Partial** |
| Railway | Partial (no CLI rollback) | Pass | Pass | Pass | Pass | **4 Pass + 1 Partial** |
| Render | Pass | Pass | Partial (no `/llms.txt`) | Pass | Partial (MCP can't deploy) | **3 Pass + 2 Partial** |

### Soft-weight adjustments applied

- **Cost-minimization is top priority (interview Q2)** — penalized expensive base tiers. Cloudflare ($0/mo realistic), Fly.io (~$2–5/mo), Render (free w/ cold starts → $7/mo), and Railway (~$5/mo) ranked above Netlify (300-credit cap, 15 credits/deploy) and Vercel (Hobby non-commercial-only, Pro $20/mo).
- **Single region OK (Q4)** — neutralized edge advantage that would otherwise lift Cloudflare/Vercel/Netlify above container PaaS options.
- **External providers fine (Q5)** — Supabase already covers auth + DB; co-located managed services (Cloudflare D1, Railway Postgres, Netlify DB, Render PG) gave no candidate a tie-breaker.
- **Zero-migration-cost** — implicit context from `AGENTS.md`: the project ships `wrangler.jsonc`, `worker-configuration.d.ts`, `astro:env/server`, and `npx wrangler deploy` workflows. Cloudflare gains a large hidden weight from this.

### Shortlisted Platforms

#### 1. Cloudflare Workers (Recommended)

5/5 Pass with zero migration cost. `wrangler 4.94.0` covers the full operational loop (deploy, rollback, tail, secrets, env, dev). Docs publish [`llms-full.txt`](https://developers.cloudflare.com/workers/llms-full.txt) and source markdown lives in [`cloudflare/cloudflare-docs`](https://github.com/cloudflare/cloudflare-docs). Cloudflare ships [13+ official remote MCP servers](https://github.com/cloudflare/mcp-server-cloudflare) — docs MCP, Workers Bindings MCP, Observability MCP, Container MCP, Browser Rendering MCP — giving Cursor structured tool-use over platform primitives. Workers Free (100k req/day, 10 ms CPU) handles 5–20 friend-pool users without strain; $5/mo Paid (10M req + 30M CPU-ms) is the predictable escape hatch.

#### 2. Fly.io

4 Pass + 1 Partial. Best deployment determinism of any candidate — `flyctl deploy` builds a Docker image and `flyctl releases rollback` is fully scriptable. ~$2–$5/mo on `shared-cpu-1x` with `auto_stop` is predictable but never $0 (Fly retired the free tier on 2024-10-07). Strongest exit-ramp from Cloudflare Workers lock-in: standard Node runtime, standard Docker, no Workers-specific footguns. MCP integration (`fly mcp launch`) is beta as of 2026-05-27.

#### 3. Railway

4 Pass + 1 Partial (Partial = no CLI rollback, dashboard-only with 72h image retention). Railpack v0.23.0 (GA since March 2026) auto-detects Astro 6 + Node 22 out of the box. MCP server is GA — local `npx -y @railway/mcp-server` and remote OAuth at `mcp.railway.com`. Realistic ~$5/mo flat on Hobby ($5/mo + $5 usage credit covers low-QPS Astro pod). Pricing churn (free → trial in 2023, prepaid removed Mar 2025) is a reputation hit but the current Hobby plan is stable.

## Anti-Bias Cross-Check: Cloudflare Workers

### Devil's Advocate — Weaknesses

1. **`nodejs_compat` flag is a silent footgun.** Drop it from `wrangler.jsonc` during a config cleanup and you get cryptic 500s in production with no clear error attribution. The Supabase SSR client depends on it. `wrangler dev` may not reproduce the failure if the local workerd version diverges from the deployed runtime.
2. **CPU time limit on Free is 10 ms per request.** Tight once Supabase auth-check + Postgres roundtrip + Astro render run together. The "free tier covers everything" math is based on request count (100k/day); the realistic ceiling is CPU-ms, which forces $5/mo Paid sooner than the req-count math implies.
3. **No native skew protection on `@astrojs/cloudflare` v13.** In-flight requests from older clients can hit newer Worker code with mismatched asset URLs during a deploy. For a 5–20 user friend pool this is rarely visible; under any concurrency it's undefined behavior.
4. **`public/_headers` doesn't apply to SSR responses on `@astrojs/cloudflare` v13** — only static assets. Easy security gap: drop a `_headers` file copied from a Pages tutorial, assume CSP/HSTS/cookie flags are covered, realize months later that auth-cookie `Secure`/`HttpOnly` weren't set on dynamic responses.
5. **Cloudflare lock-in via D1 / Workers AI / Durable Objects is structural pull.** Even though BetCup doesn't use these today, the platform's gravity well pulls you toward proprietary primitives. D1 isn't standard Postgres; Workers AI isn't a standard inference API. The discipline to stay on Supabase as DB is on the developer.

### Pre-Mortem — How This Could Fail

The team kept BetCup on Cloudflare Workers because it was already bootstrapped — zero migration cost was the deciding signal. The MVP shipped on time and ran the first World Cup group stage flawlessly. Six months later, during the quarterfinals, the admin entered a result while a participant simultaneously edited a prediction; Supabase RLS rejected the edit but the participant saw a generic 500 instead of the expected error UI. Investigation showed the `nodejs_compat_v2` flag had been bumped during a wrangler `4.94 → 4.97` upgrade three weeks earlier and broke one Supabase SSR import path that only ran on result-conflict. No CI test caught it because the test suite ran against `@astrojs/node` locally — the deployed Workers runtime hit a divergence that `astro dev` couldn't reproduce. The team realized that workerd dev parity is not runtime parity; they needed `wrangler dev` against the build artifact in CI, which they hadn't set up because "the local dev server works fine." Worse, the bundle-size limit had silently been growing as Supabase added features, and the 3 MB compressed limit started failing builds mid-tournament without an opportunity to evaluate alternatives. Root cause: "already on Cloudflare" was treated as a free pass to skip the runtime-specific CI test loop and bundle-size monitoring that the Workers runtime demands.

### Unknown Unknowns

- **Workers bundle size limit hits at deploy time, not install time.** 3 MB gzipped Free / 10 MB Paid. Adding a "harmless" dep (date-fns full import, a chart lib) can fail `wrangler deploy` without warning during `npm install`.
- **`public/_headers` doesn't apply to SSR responses** on `@astrojs/cloudflare` v13. Security headers must be set in code via `Astro.response.headers` or middleware. Easy gap if porting config from a Pages tutorial.
- **No native skew protection.** Deploy-window race conditions can serve stale asset URLs to newer JS bundles. Low concurrency hides it; any load surfaces it as undefined behavior.
- **The CPU-ms boundary breaks the "free tier covers everything" assumption before the request-count boundary does.** 10 ms CPU on Free is tight once Supabase auth + DB + render run together. Expect to upgrade to $5/mo Paid sooner than 100k req/day math suggests.
- **Wrangler version pinning matters more than docs admit.** Subtle behavior changes between minor versions can shift `nodejs_compat` semantics, env var resolution, or asset routing. Pin in `package.json` and bump deliberately, not on `npm update`.
- **`@astrojs/cloudflare` is the canonical adapter; Astro Pages is in maintenance.** Cloudflare merged Pages into Workers throughout 2025–2026 ([Pages and Workers are converging](https://blog.cloudflare.com/pages-and-workers-are-converging-into-one-experience/)) — new features land on Workers only. The starter chose Workers; staying on Workers is forward-compatible.

## Operational Story

- **Preview deploys**: GitHub Actions on PR push runs `npx wrangler deploy --env preview` to produce a preview URL on a per-PR Worker. Protect previews from public access via Cloudflare Access (free for up to 50 users) or an env-flag-guarded basic-auth middleware. Fork-PR previews skip secret injection automatically — Cloudflare doesn't expose secrets to fork builds.
- **Secrets**: `SUPABASE_URL` and `SUPABASE_KEY` live in Workers Secrets — set via `npx wrangler secret put SUPABASE_URL` (interactive prompt) and read in code via `astro:env/server` per `AGENTS.md`. GitHub Secrets hold the same pair for build-time only. **Never `import.meta.env.*` for server values** — `AGENTS.md` flags this as a hard rule. Rotation: `wrangler secret put` overwrites in place; no separate revoke step needed.
- **Rollback**: `npx wrangler rollback` reverts to the previous deployment in seconds; `npx wrangler deployments list` shows the history. Supabase migrations do NOT roll back automatically — coordinate schema rollback separately via `supabase db reset` against the migration prior to the breaking change. Treat any Worker rollback that crosses a Supabase migration boundary as a manual operation.
- **Approval**: Production deploy on merge to `main` is unattended (`ci_default_flow: auto-deploy-on-merge` per `tech-stack.md`). **Manual approval required** for: rotating `SUPABASE_KEY`, dropping a Supabase table, applying a Supabase migration that drops or renames columns, upgrading `wrangler` across a major version boundary, and any change to `wrangler.jsonc` compat flags.
- **Logs**: `npx wrangler tail` streams Worker logs locally. The [Cloudflare Workers Observability MCP server](https://observability.mcp.cloudflare.com/mcp) exposes structured log search to Cursor agents — read-only, no deploy capability. CI logs via `gh run view` per the GitHub Actions workflow in `.github/workflows/ci.yml`.

## Risk Register

| Risk | Source | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| `nodejs_compat` removed/changed → Supabase SSR 500s in prod | Devil's advocate / Pre-mortem | M | H | Pin `wrangler` major version in `package.json`; bump deliberately. Assert `compatibility_flags: ["nodejs_compat"]` in `wrangler.jsonc` is present via a pre-commit grep check or a CI test. |
| CPU-ms ceiling (10 ms Free) tightens once Supabase auth + DB + render combine | Devil's advocate / Unknown unknowns | M | M | Add Workers Analytics dashboard check post-deploy; pre-commit to `$5/mo Workers Paid` upgrade rather than refactor under pressure. |
| Bundle-size limit (3 MB Free / 10 MB Paid) breaks build on a "harmless" dep add | Unknown unknowns | M | M | Add CI step `wrangler deploy --dry-run` on every PR. Prefer tree-shakeable imports (`date-fns/format` not `date-fns`). |
| `public/_headers` ineffective for SSR — auth cookies missing `Secure`/`HttpOnly` | Devil's advocate / Unknown unknowns | M | H | Set headers in code via `Astro.response.headers` in middleware. Add a smoke test asserting `Set-Cookie` flags on `/login` POST response. |
| No skew protection → deploy-window asset URL mismatch under concurrency | Devil's advocate / Unknown unknowns | L | L | Acceptable for 5–20 user friend pool. Re-evaluate if concurrency grows; consider asset hashing with longer cache TTL. |
| Cloudflare lock-in via D1/Workers AI/DO if BetCup later adds features | Devil's advocate | L | M | Keep Supabase as DB; reject D1 unless an explicit cost-benefit analysis runs. Same rule for Workers AI vs. external inference. |
| Workers runtime divergence not caught by `astro dev` integration tests | Pre-mortem | M | H | Add a CI job that runs `wrangler dev --local` against the build artifact and exercises auth + result-conflict paths. |
| Supabase migration rolled back without Worker rollback (or vice versa) | Operational story | L | H | Document the manual coordination step in `context/changes/`; never let an agent apply a destructive Supabase migration unattended. |

## Getting Started

The project is already scaffolded on `@astrojs/cloudflare` v13 + Wrangler + Supabase per `AGENTS.md`. Next concrete steps:

1. **Authenticate Wrangler locally**: `npx wrangler login` opens a browser to authorize the CLI against your Cloudflare account.
2. **Set Workers Secrets** for the production Worker: `npx wrangler secret put SUPABASE_URL` and `npx wrangler secret put SUPABASE_KEY`. Use the project Supabase **anon public** key — [src/lib/supabase.ts](../../src/lib/supabase.ts) uses `@supabase/ssr`'s `createServerClient`, which is built for anon + user session cookies + RLS. Service-role would bypass RLS entirely and silently break FR-015 (prediction-blindness). Verify via `npx wrangler secret list`.
3. **Set GitHub repo secrets** with the same names (`SUPABASE_URL`, `SUPABASE_KEY`) for build-time consumption per `.github/workflows/ci.yml`. Confirm CI lint + build passes against the new secrets.
4. **Confirm `compatibility_flags: ["nodejs_compat"]`** is present in `wrangler.jsonc`. If absent, add it and redeploy — Supabase SSR will 500 without it.
5. **Add a `wrangler dev` smoke job to CI** (separate from `npm run dev`) that boots the build artifact against workerd and exercises `/login` POST + a protected route fetch. This is the runtime-fidelity loop the pre-mortem identified as missing.
6. **Wire the [Cloudflare docs MCP](https://docs.mcp.cloudflare.com/mcp) and [Workers Observability MCP](https://observability.mcp.cloudflare.com/mcp)** into Cursor — agent-side structured access to docs and runtime logs.
7. **First deploy**: `npx wrangler deploy` from `main` (or via the GH Actions workflow auto-deploying on merge per `tech-stack.md`).

> **Note on local dev**: `npm run dev` in this project already runs against the Cloudflare workerd runtime (per `AGENTS.md`) — there is no need for a separate `wrangler dev` command for day-to-day development. The CI smoke job in step 5 is the *only* place `wrangler dev` is required, because it exercises the build artifact rather than the source.

## Out of Scope

The following were not evaluated in this research:
- Docker image configuration (Workers doesn't use containers).
- CI/CD pipeline setup beyond the existing `.github/workflows/ci.yml`.
- Production-scale architecture (multi-region failover, HA, DR, dedicated support tiers).
- Cost projections beyond MVP (the $5/mo Workers Paid upgrade is the only post-Free step planned).
- Alternative DB choices to Supabase (Cloudflare D1 was researched for completeness only, not recommended).
