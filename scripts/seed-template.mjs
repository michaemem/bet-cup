import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const supabaseDir = join(__dirname, "..", "supabase");
const templatePath = join(supabaseDir, "seed.sql.template");
const outputPath = join(supabaseDir, "seed.sql");

const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;

// Default E2E viewer participant — the NON-admin identity the Playwright specs
// sign in as (E2E_PARTICIPANT_*). Defaults mirror tests/e2e/auth.setup.ts so a
// fresh `db:start` / `db:reset` / CI seed is immediately runnable; override via
// env to seed a different participant. The email mirrors synthEmail() in
// src/lib/username.ts (SYNTHETIC_EMAIL_DOMAIN = "betcup.local"), which is how
// username login resolves. It gets only the `participant` role because its email
// never matches app.admin_email (set to ADMIN_EMAIL by the admin block above it).
const VIEWER_USERNAME = (process.env.E2E_PARTICIPANT_USERNAME ?? "alice").trim().toLowerCase();
const VIEWER_PASSWORD = process.env.E2E_PARTICIPANT_PASSWORD ?? "participant-only";
const VIEWER_EMAIL = `${VIEWER_USERNAME}@betcup.local`;
const VIEWER_DISPLAY_NAME = VIEWER_USERNAME.charAt(0).toUpperCase() + VIEWER_USERNAME.slice(1);

const missing = [
  ["ADMIN_EMAIL", ADMIN_EMAIL],
  ["ADMIN_PASSWORD", ADMIN_PASSWORD],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);

if (missing.length > 0) {
  console.error(
    `[seed-template] Missing required env var(s): ${missing.join(", ")}.\n` +
      `Set them in .env (see .env.example) before running db:start / db:reset.`,
  );
  process.exit(1);
}

// Escape single quotes so values are safe inside the SQL string literals
// they substitute into (the template wraps each placeholder in '...').
const sqlEscape = (value) => String(value).replaceAll("'", "''");

const template = readFileSync(templatePath, "utf8");
const seed =
  "-- GENERATED FROM supabase/seed.sql.template — DO NOT EDIT\n" +
  template
    .replaceAll("{{ADMIN_EMAIL}}", sqlEscape(ADMIN_EMAIL))
    .replaceAll("{{ADMIN_PASSWORD}}", sqlEscape(ADMIN_PASSWORD))
    .replaceAll("{{VIEWER_EMAIL}}", sqlEscape(VIEWER_EMAIL))
    .replaceAll("{{VIEWER_PASSWORD}}", sqlEscape(VIEWER_PASSWORD))
    .replaceAll("{{VIEWER_DISPLAY_NAME}}", sqlEscape(VIEWER_DISPLAY_NAME));

writeFileSync(outputPath, seed);
console.log(`[seed-template] Wrote ${outputPath} for admin ${ADMIN_EMAIL} + viewer ${VIEWER_EMAIL}.`);
