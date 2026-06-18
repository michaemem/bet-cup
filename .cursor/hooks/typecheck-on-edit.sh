#!/usr/bin/env bash
# afterFileEdit hook: type-check the project after the agent edits a TS/Astro file.
#
# Unlike linting, type-checking is whole-project (TypeScript needs the full
# program), so this runs `astro check` over the whole repo rather than a single
# file. afterFileEdit is informational only — it cannot block the agent or send a
# message back to it; type errors are printed to the Hooks output channel via
# stderr.
#
# NOTE: `astro check` is relatively slow (it builds a TS program). Running it on
# every edit adds latency; consider moving this to the `stop` event if that's a
# problem.
set -uo pipefail

input="$(cat)"

file_path="$(printf '%s' "$input" | jq -r '.file_path // empty')"
[ -n "$file_path" ] || exit 0

# Only run when a type-relevant file changed.
case "$file_path" in
  *.ts | *.tsx | *.astro | *.mts | *.cts) ;;
  *) exit 0 ;;
esac

root="$(printf '%s' "$input" | jq -r '.workspace_roots[0] // empty')"
[ -n "$root" ] || root="$(pwd)"

# Hook processes can start with a minimal PATH; make sure node/npx resolve
# (e.g. when Node is installed via nvm).
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi

cd "$root" || exit 0

# Skip if Astro isn't installed in this workspace.
[ -x "node_modules/.bin/astro" ] || exit 0

# Type-check the whole project. Send all output to stderr so it shows up in the
# Hooks output channel without being parsed as hook JSON.
node_modules/.bin/astro check 1>&2 || true

exit 0
