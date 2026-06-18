#!/usr/bin/env bash
# afterFileEdit hook: run ESLint on the file the agent just edited.
#
# afterFileEdit is informational only — it cannot block the agent or send a
# message back to it. We mirror the repo's lint-staged behaviour (`eslint --fix`)
# so auto-fixable issues are corrected in place; anything left over is printed to
# the Hooks output channel via stderr.
set -uo pipefail

input="$(cat)"

file_path="$(printf '%s' "$input" | jq -r '.file_path // empty')"
[ -n "$file_path" ] || exit 0

root="$(printf '%s' "$input" | jq -r '.workspace_roots[0] // empty')"
[ -n "$root" ] || root="$(pwd)"

# Resolve to an absolute path.
case "$file_path" in
  /*) abs="$file_path" ;;
  *) abs="$root/$file_path" ;;
esac

# Only lint the file types this repo's ESLint config covers.
case "$abs" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.astro) ;;
  *) exit 0 ;;
esac

[ -f "$abs" ] || exit 0

# Hook processes can start with a minimal PATH; make sure node/npx resolve
# (e.g. when Node is installed via nvm).
if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi

cd "$root" || exit 0

# Skip if ESLint isn't installed in this workspace.
[ -x "node_modules/.bin/eslint" ] || exit 0

# Run the repo-local ESLint on just this file. Send all output to stderr so it
# shows up in the Hooks output channel without being parsed as hook JSON.
node_modules/.bin/eslint --fix "$abs" 1>&2 || true

exit 0
