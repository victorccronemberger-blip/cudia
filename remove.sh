#!/usr/bin/env bash
# cudia remover — removes the harness repo + launcher, optionally the opencode CLI.
set -euo pipefail

INSTALL_DIR="${CUDIA_DIR:-$HOME/cudia}"
BIN_DIR="${CUDIA_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}"

echo "This removes the cudia harness:"
echo "  repo:      $INSTALL_DIR"
echo "  launcher:  $BIN_DIR/cudia"
read -r -p "Continue? [y/N] " ans
case "$ans" in
  y|Y|yes) ;;
  *) echo "aborted."; exit 1 ;;
esac

rm -f "$BIN_DIR/cudia"
rm -rf "$INSTALL_DIR"
echo "==> harness removed."

if command -v opencode >/dev/null 2>&1; then
  read -r -p "Also uninstall the opencode CLI (and all its files)? [y/N] " ans2
  case "$ans2" in
    y|Y|yes) opencode uninstall ;;
    *) echo "==> opencode CLI kept." ;;
  esac
fi

echo "==> done."
