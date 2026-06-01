# 10x Astro Starter

![](./public/template.png)

A modern, opinionated starter template for building fast, accessible web applications.

## Tech Stack

- [Astro](https://astro.build/) v6 - Modern web framework with server-first rendering
- [React](https://react.dev/) v19 - UI library for interactive components
- [TypeScript](https://www.typescriptlang.org/) v5 - Type-safe JavaScript
- [Tailwind CSS](https://tailwindcss.com/) v4 - Utility-first CSS framework
- [Supabase](https://supabase.com/) - Authentication and backend-as-a-service
- [Cloudflare Workers](https://workers.cloudflare.com/) - Edge deployment runtime

## Prerequisites

- Node.js v22.14.0 (as specified in `.nvmrc`)
- npm (comes with Node.js)

## Getting Started

1. Clone the repository:

```bash
git clone https://github.com/przeprogramowani/10x-astro-starter.git
cd 10x-astro-starter
```

2. Install dependencies:

```bash
npm install
```

3. Set up Supabase and configure environment variables — see [Supabase Configuration](#supabase-configuration) below.

4. Create a `.dev.vars` file for local Cloudflare dev secrets:

```bash
cp .env.example .dev.vars
```

5. Run the development server:

```bash
npm run dev
```

## Available Scripts

- `npm run dev` - Start development server (Cloudflare workerd runtime)
- `npm run build` - Build for production
- `npm run preview` - Preview production build
- `npm run lint` - Run ESLint with type-checked rules
- `npm run lint:fix` - Auto-fix ESLint issues
- `npm run format` - Run Prettier
- `npm run db:start` - Template the local admin seed, then start the Supabase stack
- `npm run db:stop` - Stop the local Supabase stack
- `npm run db:migration:new <name>` - Scaffold a new migration file
- `npm run db:types` - Regenerate `src/db/database.types.ts` from the local DB
- `npm run db:reset` - Re-template the seed and reset the local DB to migrations + seed

## Project Structure

```md
.
├── src/
│ ├── layouts/ # Astro layouts
│ ├── pages/ # Astro pages
│ │ └── api/ # API endpoints
│ ├── components/ # UI components (Astro & React)
│ └── assets/ # Static assets
├── public/ # Public assets
├── wrangler.jsonc # Cloudflare Workers config
```

## Supabase Configuration

This project uses [Supabase](https://supabase.com/) for authentication. Environment variables are declared via Astro's `astro:env` schema and are treated as **server-only secrets** — they are never exposed to the client.

### First-time setup (local, no cloud project needed)

Requires [Docker](https://www.docker.com/) and ~7 GB RAM.

1. Create your `.env` file:

```bash
cp .env.example .env
```

2. Initialize the local Supabase project (creates a `supabase/` config folder):

```bash
npx supabase init
```

3. Start the local stack (downloads Docker images on first run). Set `ADMIN_EMAIL`/`ADMIN_PASSWORD` first and use the project wrapper, which templates the seed before booting — see [Local admin seed](#local-admin-seed):

```bash
npm run db:start
```

4. Copy the credentials printed by the CLI into your `.env` and `.dev.vars`:

```
SUPABASE_URL=http://127.0.0.1:54321
SUPABASE_KEY=<anon key from CLI output>
```

5. To stop the stack when done:

```bash
npm run db:stop
```

The local Studio UI is available at `http://localhost:54323`.

The schema (identity tables, RLS, role helpers, and the admin-seeding trigger) lives in `supabase/migrations/` and is applied automatically by `supabase start` / `npm run db:reset`. After a migration changes, regenerate the typed `Database` definition with `npm run db:types` (writes `src/db/database.types.ts`, which is committed so CI doesn't need the Supabase CLI).

### Local admin seed

BetCup has no self-registration: the single admin is seeded into the local database, and the `handle_new_user` trigger promotes them to the `admin` role automatically.

1. Set the admin credentials in your `.env`:

```
ADMIN_EMAIL=admin@betcup.local
ADMIN_PASSWORD=change-me-locally
```

2. Start the stack with the wrapper script (it templates `supabase/seed.sql` from `supabase/seed.sql.template` using those vars, then boots Supabase):

```bash
npm run db:start
```

The generated `supabase/seed.sql` is gitignored — only the template is committed, so no password ever lands in the repo. The seeded admin ends up with both `participant` and `admin` rows in `user_roles`; any other user created later gets `participant` only.

### Production admin bootstrap

In a hosted project the admin is created manually, but the same trigger handles role assignment. Order matters — the trigger reads `app.admin_email` at insert time:

1. Open the Supabase Studio **SQL editor** for the project and run:

```sql
ALTER DATABASE postgres SET app.admin_email = '<real-admin-email>';
```

2. Go to **Authentication → Add user** and create the user with that exact email. The `handle_new_user` trigger fires on insert and grants the `admin` role in addition to `participant`.

### Using a cloud Supabase project instead

If you prefer to use a hosted Supabase project, add these variables to your `.env` and `.dev.vars` files:

| Variable       | Description                                                |
| -------------- | ---------------------------------------------------------- |
| `SUPABASE_URL` | Project URL from Supabase dashboard → Settings → API       |
| `SUPABASE_KEY` | `anon` public key from Supabase dashboard → Settings → API |

```
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_KEY=<anon-key>
```

### Auth routes

| Route                | Description                                                             |
| -------------------- | ----------------------------------------------------------------------- |
| `/auth/signin`       | Email/password sign-in form                                             |
| `/dashboard`         | Example protected page (redirects to `/auth/signin` if unauthenticated) |
| `/api/auth/signin`   | Sign-in handler (`POST`)                                                |
| `/api/auth/signout`  | Sign-out handler (`POST`)                                               |

Route protection is handled in `src/middleware.ts`, which is default-deny: every route except those in the `PUBLIC_ROUTES` array requires authentication.

## Deployment

This project deploys to [Cloudflare Workers](https://workers.cloudflare.com/) as the Worker named `betcup` (URL: `https://betcup.<your-handle>.workers.dev`). See [context/changes/deployment/deployment-plan.md](./context/changes/deployment/deployment-plan.md) for the full phased rollout.

### Manual deploy

```bash
npm run build
npx wrangler deploy
```

Set `SUPABASE_URL` and `SUPABASE_KEY` (Supabase **anon** key — `@supabase/ssr` uses anon + RLS, never service-role) as Workers Secrets via `npx wrangler secret put`.

### Auto deploy

Push to `main` triggers `cloudflare/wrangler-action@v3` in `.github/workflows/ci.yml` after `lint` + `check:wrangler` + `build` pass.

### Rollback

```bash
npx wrangler deployments list           # show deploy history
npx wrangler rollback [DEPLOYMENT_ID]   # revert to a named deploy
```

Note: Supabase migrations do not roll back with the Worker; coordinate DB schema rollback separately.

## CI

GitHub Actions runs `lint` + `check:wrangler` + `build` on every push and PR to `main`, then auto-deploys to Cloudflare Workers on push to `main` only.

Required GitHub repository secrets:

| Secret | Used by | Source |
| --- | --- | --- |
| `SUPABASE_URL` | build step | Supabase dashboard → Settings → API → Project URL |
| `SUPABASE_KEY` | build step | Supabase dashboard → Settings → API → `anon` public key |
| `CLOUDFLARE_API_TOKEN` | deploy step | Cloudflare dash → My Profile → API Tokens → "Edit Cloudflare Workers" template |
| `CLOUDFLARE_ACCOUNT_ID` | deploy step | Cloudflare dash → any Worker → right sidebar |

## License

MIT
