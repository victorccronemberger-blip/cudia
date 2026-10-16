#!/usr/bin/env sh
# Remove the registered launcher, preserving the checkout and OpenCode data.
set -eu

HERE=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
. "$HERE/script/cudia-common.sh"
INSTALL_DIR=${CUDIA_DIR:-$HERE}
BIN_DIR=${CUDIA_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}
LAUNCHER=$BIN_DIR/cudia
INSTALL_DIR=$(CDPATH= cd -P -- "$INSTALL_DIR" && pwd)

if [ ! -L "$LAUNCHER" ]; then
  [ ! -e "$LAUNCHER" ] || cudia_fail "Refusing to remove a file that is not the cudia symlink: $LAUNCHER"
  printf '==> no cudia launcher found at %s\n' "$LAUNCHER"
  exit 0
fi
[ "$(readlink -- "$LAUNCHER")" = "$INSTALL_DIR/run.sh" ] ||
  cudia_fail "Refusing to remove a launcher pointing to a different checkout: $LAUNCHER"

case "${1:-}" in
  --yes) ;;
  "")
    printf 'Remove launcher %s? Checkout and session data will be kept. [y/N] ' "$LAUNCHER"
    read -r answer
    case "$answer" in y|Y|yes) ;; *) printf 'aborted.\n'; exit 1 ;; esac
    ;;
  *) cudia_fail "Usage: remove.sh [--yes]" ;;
esac
rm -- "$LAUNCHER"
printf '==> launcher removed. Checkout preserved at %s; OpenCode sessions and credentials preserved.\n' "$INSTALL_DIR"
