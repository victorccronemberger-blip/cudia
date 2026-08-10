#!/usr/bin/env bash
# cudia launcher — starts opencode with the cudia harness config loaded.
set -euo pipefail
# Resolve the real script path even when invoked through a symlink
# (BASH_SOURCE[0] holds the symlink path, so cd'ing to its dirname would
#  land in ~/.local/bin instead of the repo).
SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
HERE="$(cd "$(dirname "$SCRIPT")" && pwd)"

# Load this checkout's harness without changing the project directory selected
# by the caller. Source builds identify as the "local" channel, so force the
# shared production database to preserve access to existing session history.
export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HERE/.opencode}"
export OPENCODE_DISABLE_CHANNEL_DB="${OPENCODE_DISABLE_CHANNEL_DB:-1}"

# Prefer this repo's source so custom harness features match the checkout.
if command -v bun >/dev/null 2>&1; then
  if [ ! -e "$HERE/packages/opencode/node_modules/@opencode-ai/tui/package.json" ]; then
    echo "==> installing cudia workspace dependencies..." >&2
    (cd "$HERE" && bun install --frozen-lockfile)
  fi
  exec bun run --conditions=browser "$HERE/packages/opencode/src/index.ts" "$@"
fi

if command -v opencode >/dev/null 2>&1; then
  exec opencode "$@"
fi
if [ -x "$HOME/.opencode/bin/opencode" ]; then
  exec "$HOME/.opencode/bin/opencode" "$@"
fi

echo "opencode CLI not found. Run: curl -fsSL https://opencode.ai/install | bash" >&2
exit 1
