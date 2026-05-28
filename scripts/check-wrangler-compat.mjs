#!/usr/bin/env node
// Guards the nodejs_compat flag in wrangler.jsonc.
// Supabase SSR (`@supabase/ssr` → `createServerClient`) requires Node compat APIs;
// silently dropping this flag during a config edit causes opaque 500s in production.
// See context/foundation/infrastructure.md Risk Register entry.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(here, "..", "wrangler.jsonc");

let contents;
try {
  contents = readFileSync(configPath, "utf8");
} catch (err) {
  console.error(`FAIL: cannot read ${configPath}: ${err.message}`);
  process.exit(2);
}

// Plain substring check — wrangler.jsonc is JSONC, not standard JSON (comments + trailing commas).
// Parsing would require a JSONC parser dependency; substring is sufficient for the invariant we care about.
if (!contents.includes('"nodejs_compat"')) {
  console.error(`FAIL: wrangler.jsonc is missing "nodejs_compat" in compatibility_flags.`);
  console.error(`      Supabase SSR will 500 in production without it.`);
  console.error(`      See context/foundation/infrastructure.md Risk Register.`);
  process.exit(1);
}

console.log(`OK: wrangler.jsonc has "nodejs_compat" compat flag.`);
