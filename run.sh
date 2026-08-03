#!/usr/bin/env bash
# cudia launcher — starts opencode with the cudia harness config loaded.
set -euo pipefail
# Resolve the real script path even when invoked through a symlink
# (BASH_SOURCE[0] holds the symlink path, so cd'ing to its dirname would
#  land in ~/.local/bin instead of the repo).
SCRIPT="$(readlink -f "${BASH_SOURCE[0]}")"
HERE="$(cd "$(dirname "$SCRIPT")" && pwd)"
cd "$HERE"

if command -v opencode >/dev/null 2>&1; then
  exec opencode "$@"
fi
if [ -x "$HOME/.opencode/bin/opencode" ]; then
  exec "$HOME/.opencode/bin/opencode" "$@"
fi

echo "opencode CLI not found. Run: curl -fsSL https://opencode.ai/install | bash" >&2
exit 1
