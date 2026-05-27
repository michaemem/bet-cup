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
- `npm run build` — production SSR build. CI: lint + build on push/PR to `master` (`@.github/workflows/ci.yml`).
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

Only the initial commit exists. Adopt a convention (Conventional Commits is a reasonable default) and document it here once several commits land. PRs must pass `lint` + `build`. Set `SUPABASE_URL` / `SUPABASE_KEY` as GitHub repo secrets for the build.

## Configuration

- Node version per `@.nvmrc`; CI pins Node 22 (`@.github/workflows/ci.yml`).
- Local env: copy `.env.example` to `.env` (Node) and `.dev.vars` (Cloudflare local). Both gitignored.
- Cloudflare deploy: `npx wrangler deploy`; production secrets via `npx wrangler secret put`.
