import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import "dotenv/config";

/**
 * E2E config for BetCup (Phase 4 — see context/foundation/test-plan.md §6.4/§6.5).
 *
 * Loads `.env` (dotenv) so specs see the same `SUPABASE_URL` / `SUPABASE_KEY` the
 * app uses plus the `E2E_*` fixture knobs. `webServer` boots the real Astro SSR
 * app (`npm run dev`) — E2E drives the running app, with internal boundaries
 * (auth, routing, Supabase) kept real; only the local Supabase stack (Docker)
 * must be up first (`npm run db:start`).
 *
 * Auth is done ONCE, not in the UI per test (the "authenticate without the UI"
 * rule): the `setup` project signs in and writes the session to STORAGE_STATE;
 * every other project reuses it via `storageState`, so specs start authenticated.
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:4321";

/** Where the `setup` project saves the signed-in session for the other projects. */
export const STORAGE_STATE = path.resolve(import.meta.dirname, "playwright/.auth/user.json");

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: STORAGE_STATE },
      dependencies: ["setup"],
    },
  ],
  webServer: {
    command: "npm run dev",
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
