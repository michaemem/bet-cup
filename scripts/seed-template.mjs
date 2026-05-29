import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const supabaseDir = join(__dirname, "..", "supabase");
const templatePath = join(supabaseDir, "seed.sql.template");
const outputPath = join(supabaseDir, "seed.sql");

const { ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;

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

const template = readFileSync(templatePath, "utf8");
const seed =
  "-- GENERATED FROM supabase/seed.sql.template — DO NOT EDIT\n" +
  template.replaceAll("{{ADMIN_EMAIL}}", ADMIN_EMAIL).replaceAll("{{ADMIN_PASSWORD}}", ADMIN_PASSWORD);

writeFileSync(outputPath, seed);
console.log(`[seed-template] Wrote ${outputPath} for admin ${ADMIN_EMAIL}.`);
