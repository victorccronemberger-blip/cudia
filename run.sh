#!/usr/bin/env bash
# cudia launcher — starts opencode with the cudia harness config loaded.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

if command -v opencode >/dev/null 2>&1; then
  exec opencode "$@"
fi
if [ -x "$HOME/.opencode/bin/opencode" ]; then
  exec "$HOME/.opencode/bin/opencode" "$@"
fi

echo "opencode CLI not found. Run: curl -fsSL https://opencode.ai/install | bash" >&2
exit 1
