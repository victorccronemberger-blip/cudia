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

if command -v bun >/dev/null 2>&1; then
  echo "==> updating cudia workspace dependencies..."
  (cd "$INSTALL_DIR" && bun install --frozen-lockfile)
  echo "==> rebuilding cudia local binary..."
  (cd "$INSTALL_DIR/packages/opencode" && bun run script/build.ts --single --skip-install --skip-embed-web-ui)
else
  echo "!! bun not found; custom source dependencies were not installed."
  echo "   Install it with: curl -fsSL https://bun.sh/install | bash"
fi

echo "==> updating opencode CLI..."
curl -fsSL https://opencode.ai/install | bash

echo "==> done. Restart opencode to pick up the changes."
