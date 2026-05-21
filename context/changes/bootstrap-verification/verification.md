---
bootstrapped_at: 2026-05-20T20:40:11Z
starter_id: 10x-astro-starter
starter_name: "10x Astro Starter (Astro + Supabase + Cloudflare)"
project_name: bet-cup
language_family: js
package_manager: npm
cwd_strategy: git-clone
bootstrapper_confidence: first-class
phase_3_status: ok
audit_command: "npm audit --json"
---

# Bootstrap verification log — bet-cup

## Hand-off

```yaml
starter_id: 10x-astro-starter
package_manager: npm
project_name: bet-cup
hints:
  language_family: js
  team_size: solo
  deployment_target: cloudflare-pages
  ci_provider: github-actions
  ci_default_flow: auto-deploy-on-merge
  bootstrapper_confidence: first-class
  path_taken: standard
  quality_override: false
  self_check_answers: null
  has_auth: true
  has_payments: false
  has_realtime: false
  has_ai: false
  has_background_jobs: false
```

> Solo developer shipping a private prediction-pool web app in three weeks of after-hours work. Auth is the only technology-forcing feature in scope — admin-created accounts, login + password, change-password, login-redirect. Real-time updates, payments, AI/LLM features, background jobs, and external sports/fixtures integrations are explicit PRD non-goals. The 10x-astro-starter is the recommended default for the (web, js) cell and bundles exactly what BetCup needs out of the box: typed UI components, a relational database with auth ready to wire up, and an edge deploy target — clearing all four agent-friendly gates with first-class bootstrapper confidence so scaffolding should be smooth. Cloudflare Pages was picked as the deployment target (the starter's first default); CI is GitHub Actions with auto-deploy on merge to main, the starter's standard shape. PHP and Java/Spring were ruled out by stated avoids during shaping; with the JS/TS language family confirmed, the recommended-defaults map resolved cleanly to this starter without needing to walk the full custom interview.

## Pre-scaffold verification

| Signal      | Value                                                                | Severity | Notes                                                                       |
| ----------- | -------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| npm package | not run                                                              | n/a      | cmd_template uses `git clone`, not a `create-*` CLI; no npm package to query |
| GitHub repo | github.com/przeprogramowani/10x-astro-starter last pushed 2026-05-17 | fresh    | from card.docs_url; queried via GitHub REST API (`gh` CLI unavailable on host) |

## Scaffold log

**Resolved invocation**: `git clone https://github.com/przeprogramowani/10x-astro-starter .bootstrap-scaffold && cd .bootstrap-scaffold && npm install`
**Strategy**: git-clone
**Exit code**: 0 (clone exit 0; npm install exit 0; chained as two sequential PowerShell calls because PS 5.1 doesn't support `&&` natively — semantics preserved: install only ran because clone succeeded)
**Files moved**: 20 (`.github`, `.husky`, `.vscode`, `node_modules`, `public`, `src`, `supabase`, `.env.example`, `.gitignore`, `.nvmrc`, `.prettierrc.json`, `astro.config.mjs`, `CLAUDE.md`, `components.json`, `eslint.config.js`, `package-lock.json`, `package.json`, `README.md`, `tsconfig.json`, `wrangler.jsonc`)
**Conflicts (.scaffold siblings)**: none
**.gitignore handling**: moved silently (no `.gitignore` existed in cwd before scaffold)
**.bootstrap-scaffold cleanup**: deleted (`.bootstrap-scaffold/.git/` removed first per git-clone strategy; remaining entries moved up; temp dir removed)

The cwd `.git/` repository (which existed before bootstrap) was preserved untouched. The cloned upstream `.git/` history was discarded so the user starts with their own git history (or none) rather than inheriting the starter's.

## Post-scaffold audit

**Tool**: `npm audit --json`
**Summary**: 0 CRITICAL, 1 HIGH, 10 MODERATE, 0 LOW (total: 11 advisories across 895 dependencies; 449 prod / 316 dev / 131 optional)
**Direct vs transitive**: 0/0/3/0 direct of total 0/1/10/0 — the 1 HIGH and 7 of 10 MODERATE findings are transitive; 3 MODERATE findings are on direct dependencies (`@astrojs/check`, `@astrojs/cloudflare`, `wrangler`).

#### CRITICAL findings

None.

#### HIGH findings

- **`devalue`** (transitive; range `5.6.3 - 5.8.0`)
  Advisory: *Svelte devalue: DoS via sparse array deserialization* — [GHSA-77vg-94rm-hx3p](https://github.com/advisories/GHSA-77vg-94rm-hx3p)
  Reach chain: `@astrojs/cloudflare → @cloudflare/vite-plugin → miniflare → devalue` (and similar through `wrangler`).
  npm reports a fix is available; addressing it likely means bumping `@astrojs/cloudflare` (or pinning `devalue` via overrides in `package.json`). This is the only finding above MODERATE — worth a look before first deploy.

#### MODERATE findings

Direct dependencies (3):

- **`@astrojs/check`** (direct; range `>=0.9.3`) — npm suggests fix `0.9.2` (semver-major downgrade); pulled in via `@astrojs/language-server → volar-service-yaml → yaml-language-server → yaml`.
- **`@astrojs/cloudflare`** (direct; range `>=12.2.4`) — npm suggests fix `12.6.13` (semver-major); the umbrella for the `@cloudflare/vite-plugin → miniflare → ws` and `→ devalue` chains.
- **`wrangler`** (direct; range `<=0.0.0-kickoff-demo || >=3.108.0`) — npm suggests fix `3.107.3` (semver-major downgrade); umbrella for the `miniflare → ws` chain.

Transitive dependencies (7):

- **`@astrojs/language-server`** (range `>=2.14.0`) — via `volar-service-yaml → yaml-language-server → yaml`.
- **`@cloudflare/vite-plugin`** (range `<=0.0.0-fff677e35 || >=0.0.7`) — via `miniflare`, `wrangler`, and `ws`.
- **`miniflare`** (range `<=0.0.0-fff677e35 || >=3.20250204.0`) — via `ws`.
- **`volar-service-yaml`** (range `<=0.0.70`) — via `yaml-language-server`.
- **`ws`** (range `8.0.0 - 8.20.0`) — *ws: Uninitialized memory disclosure* ([GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx)).
- **`yaml`** (range `2.0.0 - 2.8.2`) — *yaml is vulnerable to Stack Overflow via deeply nested YAML collections* ([GHSA-48c2-rrv3-qjmp](https://github.com/advisories/GHSA-48c2-rrv3-qjmp)).
- **`yaml-language-server`** (range `1.11.1-08d5f7b.0 - 1.21.1-f1f5a94.0 || 1.22.1-0ae5603.0 - 1.22.1-fc5f874.0`) — via `yaml`.

#### LOW / INFO findings

None.

Note on suggested fixes: several entries propose semver-major downgrades because the starter's pinned versions are newer than the upper bound of the patched range published at the time `npm audit` ran. That's a known npm-audit quirk for fast-moving starters — running `npm audit fix` here is more likely to break the build than help. Treat these as advisories to watch, not fixes to apply blindly.

## Hints recorded but not acted on

| Hint                       | Value                  |
| -------------------------- | ---------------------- |
| bootstrapper_confidence    | first-class            |
| quality_override           | false                  |
| path_taken                 | standard               |
| self_check_answers         | null                   |
| team_size                  | solo                   |
| deployment_target          | cloudflare-pages       |
| ci_provider                | github-actions         |
| ci_default_flow            | auto-deploy-on-merge   |
| has_auth                   | true                   |
| has_payments               | false                  |
| has_realtime               | false                  |
| has_ai                     | false                  |
| has_background_jobs        | false                  |

A future skill (Memory Architecture / agent context) will act on these — generating `AGENTS.md` / `CLAUDE.md` content, wiring `.github/workflows/`, and choosing deployment-specific scaffolding. v1 of bootstrapper preserves the audit trail without taking those actions. Note that the starter ships its own `CLAUDE.md` (now in cwd) and a `.github/` directory (workflows the starter's maintainer authored); those are not bootstrapper-generated.

## Next steps

Next: a future skill will set up agent context (CLAUDE.md, AGENTS.md). For now, your project is scaffolded and verified — happy hacking.

Useful manual steps in the meantime:

- `git init` (if you have not already) to start your own repo history. The cwd already has a `.git/` from before bootstrap, so no init is needed if that repo is what you intend to commit to.
- Review the starter's bundled `CLAUDE.md`, `README.md`, and `.github/` workflows — these came from the upstream starter and may need tweaking for BetCup specifically.
- Address the 1 HIGH (`devalue`, transitive via `@astrojs/cloudflare`) and the 3 direct MODERATE findings per your project's risk tolerance. The full breakdown is in this log; `npm audit fix` is **not** recommended here without inspecting individual advisories first (see the "Note on suggested fixes" above).
- Set up `.env` from `.env.example` — the starter expects Supabase keys (project URL + anon/service-role keys) before `npm run dev` will be useful. Auth, the only feature flag set on this PRD, lives in Supabase per the starter's design.
