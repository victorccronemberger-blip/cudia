#!/usr/bin/env bash
# cudia installer (Kali Linux / Debian-based)
#  - installs the opencode CLI (official installer, latest stable)
#  - clones the cudia harness repo to ~/cudia
#  - creates the `cudia` launcher in ~/.local/bin
set -uo pipefail

REPO_URL="${CUDIA_REPO_URL:-https://github.com/victorccronemberger-blip/cudia.git}"
INSTALL_DIR="${CUDIA_DIR:-$HOME/cudia}"
BIN_DIR="${CUDIA_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"

# 1. opencode CLI
OPENCODE_BIN="$(command -v opencode || true)"
if [ -z "$OPENCODE_BIN" ] && [ -x "$HOME/.opencode/bin/opencode" ]; then
  OPENCODE_BIN="$HOME/.opencode/bin/opencode"
fi

if [ -n "$OPENCODE_BIN" ]; then
  echo "==> opencode already installed: $OPENCODE_BIN"
else
  echo "==> installing opencode CLI (latest stable)..."
  if curl -fsSL https://opencode.ai/install | bash; then
    OPENCODE_BIN="$(command -v opencode || true)"
    [ -z "$OPENCODE_BIN" ] && [ -x "$HOME/.opencode/bin/opencode" ] && OPENCODE_BIN="$HOME/.opencode/bin/opencode"
    [ -n "$OPENCODE_BIN" ] && echo "==> opencode installed: $OPENCODE_BIN"
  else
    echo "!! opencode installer failed (network?). Install it manually, then re-run:"
    echo "   curl -fsSL https://opencode.ai/install | bash"
  fi
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
chmod +x "$INSTALL_DIR"/*.sh 2>/dev/null || true

# 3. launcher
mkdir -p "$BIN_DIR"
ln -sfn "$INSTALL_DIR/run.sh" "$BIN_DIR/cudia"
echo "==> launcher installed: $BIN_DIR/cudia"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "==> $BIN_DIR is already on PATH." ;;
  *)
    echo "!! $BIN_DIR is NOT on your PATH. Add one of these to your shell:"
    echo "   bash/zsh:  export PATH=\"$BIN_DIR:\$PATH\""
    echo "   or run:    ln -sfn $BIN_DIR/cudia /usr/local/bin/cudia   (with sudo)"
    ;;
esac

echo
echo "Done. Usage:"
echo "  cudia                      # opencode TUI with the cudia harness"
echo "  cudia --model deepseek/deepseek-v4-pro"
echo "  cudia /kali <target>       # run the Kali agent"
echo
echo "Update:  $INSTALL_DIR/update.sh"
echo "Remove:  $INSTALL_DIR/remove.sh"
