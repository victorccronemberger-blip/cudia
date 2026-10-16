#!/usr/bin/env sh
# Install this checkout's custom engine and a launcher; no global OpenCode install.
set -eu

HERE=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
. "$HERE/script/cudia-common.sh"
REPO_URL=${CUDIA_REPO_URL:-https://github.com/victorccronemberger-blip/cudia.git}
INSTALL_DIR=${CUDIA_DIR:-$HERE}
BIN_DIR=${CUDIA_BIN_DIR:-${XDG_BIN_HOME:-$HOME/.local/bin}}

command -v git >/dev/null 2>&1 || cudia_fail "Git is required."
if [ ! -e "$INSTALL_DIR" ]; then
  mkdir -p -- "$(dirname -- "$INSTALL_DIR")"
  git clone -- "$REPO_URL" "$INSTALL_DIR"
fi
cudia_checkout "$INSTALL_DIR"
INSTALL_DIR=$(CDPATH= cd -P -- "$INSTALL_DIR" && pwd)
mkdir -p -- "$BIN_DIR"
LAUNCHER=$BIN_DIR/cudia
if [ -L "$LAUNCHER" ]; then
  [ "$(readlink -- "$LAUNCHER")" = "$INSTALL_DIR/run.sh" ] ||
    cudia_fail "A different launcher already exists at $LAUNCHER; move it before installing."
elif [ -e "$LAUNCHER" ]; then
  cudia_fail "A file already exists at $LAUNCHER; move it before installing."
fi
cudia_build "$INSTALL_DIR"
if [ ! -L "$LAUNCHER" ]; then
  case "$CUDIA_PLATFORM" in
    # Default Git Bash ln may copy the file when native symlinks are unavailable.
    # MSYS shortcuts retain actual symlink behavior without administrator rights.
    windows) MSYS="${MSYS:+$MSYS }winsymlinks:lnk" ln -s -- "$INSTALL_DIR/run.sh" "$LAUNCHER" ;;
    *) ln -s -- "$INSTALL_DIR/run.sh" "$LAUNCHER" ;;
  esac
fi
printf '==> launcher installed: %s\n' "$LAUNCHER"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add this directory to PATH: %s\n' "$BIN_DIR" ;;
esac
printf 'Run: cudia\nUpdate: %s/update.sh\nRemove launcher: %s/remove.sh\n' "$INSTALL_DIR" "$INSTALL_DIR"
