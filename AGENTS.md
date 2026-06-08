# Repository Guidelines

BetCup is a private football-tournament prediction pool — Astro 6 SSR + React 19 islands + Tailwind 4 + Supabase auth, deployed to Cloudflare Workers. Product requirements: `@context/foundation/prd.md`.

## Hard rules

- **API routes (`src/pages/api/**`) must export `const prerender = false`.** Without it they prerender at build and break in production.
- **Server secrets (`SUPABASE_URL`, `SUPABASE_KEY`) only via `astro:env/server`.** Never `import.meta.env.*` for server values — they leak to the client.
- **New Supabase tables: enable RLS** with per-operation, per-role policies.
- **Tailwind class composition uses `cn()` from `@/lib/utils`.** No manual class concatenation.
- **No Next.js directives** (`"use client"`, etc.). React components hydrate via `client:*` in `.astro` files.
- **shadcn/ui** ("new-york" variant): add via `npx shadcn@latest add <name>`. Don't hand-author files in `src/components/ui/`.

## Build, test, and development commands

- `npm run dev` — dev server (Cloudflare workerd).
- `npm run lint` — ESLint, strict-type-checked. **CI gate.**
- `npm run build` — production SSR build. CI: lint + `check:wrangler` + build on push/PR to `main`; auto-deploy via `cloudflare/wrangler-action` on push to `main` only (`@.github/workflows/ci.yml`).
- `npm run check:wrangler` — guards the `nodejs_compat` flag in `wrangler.jsonc`. Runs in pre-commit (lint-staged) on wrangler.jsonc changes and in CI. Removing the flag silently breaks Supabase SSR in production.
- `npx supabase start` — local Supabase stack (Docker required); setup: `@README.md`.

No test suite yet — add one (e.g., Vitest) before the first feature merges.

## Project structure

- `src/pages/` — Astro routes. `src/pages/api/` handlers use uppercase `GET`/`POST` exports and `zod` for input validation.
- `src/components/` — Astro for static, React for interactive. shadcn primitives in `src/components/ui/`; extract React hooks to `src/components/hooks/`.
- `src/lib/` — `supabase.ts` (SSR auth client) and `utils.ts` (`cn()`). Extracted services go in `src/lib/services/`. Shared entity/DTO types in `src/types.ts`.
- `src/middleware.ts` — auth gate. Sets `context.locals.user` from cookies; redirects unauthenticated requests for paths in `PROTECTED_ROUTES`.
- `supabase/migrations/` — naming `YYYYMMDDHHmmss_short_description.sql`.
- `context/` — product foundation and change-tracking. Do not delete on cleanup.
- Path alias `@/*` → `./src/*` (`@tsconfig.json`).

## Coding style

- TypeScript with `strictTypeChecked` preset; react-compiler errors enforced (`@eslint.config.js`).
- File naming: PascalCase for components (`SignInForm.tsx`, `Banner.astro`), kebab-case otherwise (`config-status.ts`). Prefix unused identifiers with `_`.
- Husky + lint-staged auto-fix on commit (config in `@package.json`).

## Commit & pull request guidelines

Adopt Conventional Commits as the default convention. PRs must pass `lint` + `check:wrangler` + `build`. Required GitHub repo secrets: `SUPABASE_URL`, `SUPABASE_KEY` (build), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (deploy on push to `main`).

## Configuration

- Node version per `@.nvmrc`; `engines.node` enforces `>=22.14.0 <23.0.0`; CI pins Node 22 (`@.github/workflows/ci.yml`).
- Local env: copy `.env.example` to `.env` (Node) and `.dev.vars` (Cloudflare local). Both gitignored.
- MCP servers wired in `@.cursor/mcp.json`: `cloudflare-docs` (read-only, public) and `cloudflare-observability` (Workers Logs read-only; OAuths on first use against your Cloudflare account).
- Cloudflare deploy: auto on push to `main`; manual fallback `npx wrangler deploy`; production secrets via `npx wrangler secret put`.
- **Supabase migrations are NOT auto-applied to prod.** CI's `deploy` job only runs `wrangler deploy` — it never runs `supabase db push`. After any new migration merges to `main`, apply it to prod manually: `npx supabase db push` (preview first with `--dry-run`). Check drift any time with `npx supabase migration list --linked` (linked project: `betcup-prod`). `db push` applies schema only — it does not load `supabase/seed.sql` (local-only).
- GitHub Actions secrets required: `SUPABASE_URL`, `SUPABASE_KEY` (build-time), `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (deploy-time).
- Worker name: `betcup`. Production URL: `https://betcup.pacs.workers.dev` (account `workers.dev` subdomain is `pacs`; the Worker name stays `betcup`).

## Rollback runbook

- `npx wrangler deployments list` — show deploy history (id + commit + timestamp).
- `npx wrangler rollback [DEPLOYMENT_ID]` — revert to the named deploy in seconds. Omitting the id rolls back to the previous version.
- **Supabase migrations do NOT roll back with the Worker.** If the rollback crosses a Supabase migration boundary, coordinate the DB schema rollback separately (`supabase db reset` to the pre-breaking migration). Treat any cross-boundary rollback as a manual operation.

## Manual approval gates (never autonomous)

The following are never to be executed by an agent without explicit human approval:

- Rotating `SUPABASE_KEY` (any side: Workers Secret, GitHub Secret, local `.dev.vars`).
- Dropping a Supabase table, or applying a migration that drops/renames columns.
- Upgrading `wrangler` across a major version boundary.
- Any change to `wrangler.jsonc` `compatibility_flags` or `compatibility_date`.
- Rotating `CLOUDFLARE_API_TOKEN` or changing its scope.
