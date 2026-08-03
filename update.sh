#!/usr/bin/env bash
# cudia updater — pulls the latest harness + reinstalls the opencode CLI.
set -euo pipefail

INSTALL_DIR="${CUDIA_DIR:-$HOME/cudia}"

[ -d "$INSTALL_DIR/.git" ] || {
  echo "!! cudia not installed at $INSTALL_DIR — run install.sh first"
  exit 1
}

echo "==> updating harness repo..."
git -C "$INSTALL_DIR" pull --ff-only
chmod +x "$INSTALL_DIR"/*.sh 2>/dev/null || true

echo "==> updating opencode CLI..."
curl -fsSL https://opencode.ai/install | bash

echo "==> done. Restart opencode to pick up the changes."
