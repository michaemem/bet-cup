#!/usr/bin/env bash
# Start the local Supabase stack and sync its generated credentials into the
# local secret files. Rerunnable and idempotent — safe to run any time the keys
# are missing/stale (e.g. after a `npm run db:stop` or a fresh container).
#
# It writes into BOTH files the app reads:
#   .env       -> Node scripts, Vitest, Playwright, `npm run build`
#   .dev.vars  -> the Cloudflare workerd runtime behind `npm run dev`
#
# Keys written:
#   SUPABASE_URL, SUPABASE_KEY (anon), SUPABASE_SERVICE_ROLE_KEY  (app + build)
#   SUPABASE_ANON_KEY, SUPABASE_DB_URL                            (RLS tests)
set -euo pipefail

cd "$(dirname "$0")/.."

if ! docker info >/dev/null 2>&1; then
  echo "!! Docker daemon is not reachable. Is the docker-in-docker feature up?" >&2
  exit 1
fi

echo "==> Starting Supabase (npm run db:start) — first run downloads images, be patient"
npm run db:start

echo "==> Reading credentials from 'supabase status'"
# `-o env` prints valid shell assignments (API_URL=..., ANON_KEY=..., etc.).
eval "$(npx supabase status -o env)"

: "${API_URL:?supabase status did not report API_URL}"
: "${ANON_KEY:?supabase status did not report ANON_KEY}"
: "${SERVICE_ROLE_KEY:?supabase status did not report SERVICE_ROLE_KEY}"
: "${DB_URL:?supabase status did not report DB_URL}"

# Upsert keys via Node to avoid sed-escaping issues with JWT/URL values.
SB_URL="$API_URL" SB_ANON="$ANON_KEY" SB_SERVICE="$SERVICE_ROLE_KEY" SB_DB="$DB_URL" \
node - <<'NODE'
const fs = require("node:fs");

const url = process.env.SB_URL;
const anon = process.env.SB_ANON;
const service = process.env.SB_SERVICE;
const dbUrl = process.env.SB_DB;

/** Replace KEY=... in place if present, else append it. */
function upsert(contents, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(contents)) return contents.replace(re, line);
  return (contents.endsWith("\n") || contents === "" ? contents : contents + "\n") + line + "\n";
}

function sync(file, pairs) {
  let contents = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  for (const [k, v] of pairs) contents = upsert(contents, k, v);
  fs.writeFileSync(file, contents);
  console.log(`==> Synced ${pairs.map(([k]) => k).join(", ")} into ${file}`);
}

sync(".env", [
  ["SUPABASE_URL", url],
  ["SUPABASE_KEY", anon],
  ["SUPABASE_SERVICE_ROLE_KEY", service],
  ["SUPABASE_ANON_KEY", anon],
  ["SUPABASE_DB_URL", dbUrl],
]);

sync(".dev.vars", [
  ["SUPABASE_URL", url],
  ["SUPABASE_KEY", anon],
  ["SUPABASE_SERVICE_ROLE_KEY", service],
]);
NODE

cat <<EOF

==> Supabase is up.
      API      $API_URL
      Studio   ${STUDIO_URL:-http://localhost:54323}
      DB       $DB_URL

Credentials written to .env and .dev.vars. You can now:
      npm run dev      # dev server at http://localhost:4321
      npm test         # unit tests
      npm run e2e       # end-to-end tests

To run the live-DB RLS integration tests (they self-skip without env):
      set -a; . ./.env; set +a; npm test -- rls
EOF
