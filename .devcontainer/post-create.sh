#!/usr/bin/env bash
# One-time bootstrap after the devcontainer is created.
#   - installs npm dependencies (incl. the Supabase CLI, a devDependency)
#   - seeds local secret files (.env, .dev.vars) from .env.example
#   - installs the Playwright Chromium browser + its OS libraries for e2e
# Bringing the database up (and syncing its keys into .env) is a separate,
# rerunnable step: `bash .devcontainer/supabase-up.sh`.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Installing npm dependencies"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

# .env is read by Node scripts (seed-template, vitest, playwright); .dev.vars is
# read by the Cloudflare workerd dev runtime (npm run dev). Both are gitignored.
# We only scaffold them — the real Supabase keys are filled in by supabase-up.sh
# once the stack has started and printed them.
for target in .env .dev.vars; do
  if [ ! -f "$target" ]; then
    cp .env.example "$target"
    echo "==> Created $target from .env.example"
  else
    echo "==> $target already exists — leaving it untouched"
  fi
done

echo "==> Setting up Git identity + SSH keys from the host"
# Copy (don't symlink) the read-only host mounts into the container home so we
# can enforce strict SSH perms and let the container update known_hosts freely.
if [ -f "$HOME/.gitconfig-host" ]; then
  cp "$HOME/.gitconfig-host" "$HOME/.gitconfig"
  echo "==> Copied host .gitconfig ($(git config --global user.name 2>/dev/null || echo 'no name set'))"
else
  echo "!! No host .gitconfig mounted — set git user.name/email manually if needed"
fi

if [ -d "$HOME/.ssh-host" ]; then
  mkdir -p "$HOME/.ssh"
  cp -r "$HOME/.ssh-host/." "$HOME/.ssh/"
  chmod 700 "$HOME/.ssh"
  # Private keys / config → 600, public keys → 644.
  find "$HOME/.ssh" -type f ! -name '*.pub' -exec chmod 600 {} +
  find "$HOME/.ssh" -type f -name '*.pub' -exec chmod 644 {} +
  # Make sure github.com is a trusted host so the first push isn't interactive.
  ssh-keyscan -t rsa,ecdsa,ed25519 github.com >> "$HOME/.ssh/known_hosts" 2>/dev/null || true
  sort -u "$HOME/.ssh/known_hosts" -o "$HOME/.ssh/known_hosts" 2>/dev/null || true
  echo "==> Copied host SSH keys into ~/.ssh"
else
  echo "!! No host .ssh mounted — SSH git operations won't be available"
fi

echo "==> Installing Playwright Chromium + system libraries"
# System libs need root (node has passwordless sudo); the browser itself is
# installed into the node user's cache. Non-fatal so a slow/offline mirror
# doesn't block the whole container from coming up.
sudo env "PATH=$PATH" npx --yes playwright install-deps chromium || \
  echo "!! Playwright system deps failed — rerun 'sudo npx playwright install-deps chromium' later"
npx --yes playwright install chromium || \
  echo "!! Playwright browser install failed — rerun 'npx playwright install chromium' later"

cat <<'EOF'

==> Devcontainer ready.

Next steps:
  1. Start the database + sync its keys into .env/.dev.vars:
       bash .devcontainer/supabase-up.sh
  2. Run the dev server (http://localhost:4321):
       npm run dev
  3. Run tests:
       npm test        # unit tests (Vitest, no DB needed)
       npm run e2e      # end-to-end (needs the DB + dev server)

EOF
