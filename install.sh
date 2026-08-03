#!/usr/bin/env bash
# cudia installer (Kali Linux / Debian-based)
#  - installs the opencode CLI (official installer, latest stable)
#  - clones the cudia harness repo to ~/cudia
#  - creates the `cudia` launcher in ~/.local/bin
set -euo pipefail

REPO_URL="${CUDIA_REPO_URL:-https://github.com/victorccronemberger-blip/cudia.git}"
INSTALL_DIR="${CUDIA_DIR:-$HOME/cudia}"
BIN_DIR="${CUDIA_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"

# 1. opencode CLI
if command -v opencode >/dev/null 2>&1; then
  echo "==> opencode already installed: $(opencode --version 2>/dev/null || echo unknown)"
else
  echo "==> installing opencode CLI (latest stable)..."
  curl -fsSL https://opencode.ai/install | bash
  command -v opencode >/dev/null 2>&1 || {
    echo "!! opencode installed but not on PATH."
    echo "   Add one of these to your shell profile:"
    echo "   export PATH=\"\$HOME/.opencode/bin:\$PATH\"   # or"
    echo "   export PATH=\"\$HOME/.local/bin:\$PATH\""
  }
fi

# 2. harness repo
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "==> updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  mkdir -p "$(dirname "$INSTALL_DIR")"
  echo "==> cloning harness to $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

# 3. launcher
mkdir -p "$BIN_DIR"
ln -sfn "$INSTALL_DIR/run.sh" "$BIN_DIR/cudia"
echo "==> launcher installed: $BIN_DIR/cudia"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "==> add to PATH: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

echo
echo "Done. Usage:"
echo "  cudia                      # opencode TUI with the cudia harness"
echo "  cudia --model deepseek/deepseek-v4-pro"
echo "  cudia /kali <target>       # run the Kali agent"
echo
echo "Update:  $INSTALL_DIR/update.sh"
echo "Remove:  $INSTALL_DIR/remove.sh"
