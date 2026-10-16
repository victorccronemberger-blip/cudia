#!/usr/bin/env sh
# Update the checkout and rebuild its custom engine without replacing local work.
set -eu

HERE=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
. "$HERE/script/cudia-common.sh"
INSTALL_DIR=${CUDIA_DIR:-$HERE}
cudia_checkout "$INSTALL_DIR"
git -C "$INSTALL_DIR" diff --quiet || cudia_fail "Tracked files have local edits; commit or stash them before updating."
git -C "$INSTALL_DIR" diff --cached --quiet || cudia_fail "The index has local edits; commit or stash them before updating."
[ -n "$(git -C "$INSTALL_DIR" branch --show-current)" ] || cudia_fail "Select a tracking branch before updating a detached checkout."

printf '==> updating checkout...\n'
git -C "$INSTALL_DIR" pull --ff-only
# Load the updated helper as well as the updated build script.
. "$INSTALL_DIR/script/cudia-common.sh"
cudia_build "$INSTALL_DIR"
printf '==> updated. Restart cudia to use the new engine.\n'
