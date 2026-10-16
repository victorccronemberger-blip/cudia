#!/usr/bin/env sh
# Load the harness from this checkout while keeping the caller's project directory.
set -eu

# macOS readlink does not support -f. Follow relative links without that flag.
SCRIPT=$0
while [ -L "$SCRIPT" ]; do
  DIR=$(CDPATH= cd -P -- "$(dirname -- "$SCRIPT")" && pwd)
  LINK=$(readlink -- "$SCRIPT")
  case "$LINK" in
    /*) SCRIPT=$LINK ;;
    *) SCRIPT=$DIR/$LINK ;;
  esac
done
HERE=$(CDPATH= cd -P -- "$(dirname -- "$SCRIPT")" && pwd)
. "$HERE/script/cudia-common.sh"

export OPENCODE_CONFIG_DIR="${OPENCODE_CONFIG_DIR:-$HERE/.opencode}"
# Custom builds share the production database, retaining existing session history.
export OPENCODE_DISABLE_CHANNEL_DB="${OPENCODE_DISABLE_CHANNEL_DB:-1}"
# Discover MCP schemas on demand instead of sending the whole catalog every turn.
export OPENCODE_EXPERIMENTAL_CODE_MODE="${OPENCODE_EXPERIMENTAL_CODE_MODE:-1}"
# Keep catalogs in discovery tools; retain a small neutral operational base.
export CUDIA_CONTEXT_MODE="${CUDIA_CONTEXT_MODE:-lean}"
# Expose native web search to any model; the backend is called only on tool use.
export OPENCODE_ENABLE_EXA="${OPENCODE_ENABLE_EXA:-1}"

cudia_platform "$HERE"
cudia_fingerprint "$HERE"
if [ ! -x "$CUDIA_LOCAL_BIN" ] || [ ! -f "$CUDIA_BUILD_STAMP" ] ||
  [ "$(cat "$CUDIA_BUILD_STAMP")" != "$CUDIA_FINGERPRINT" ]; then
  cudia_build "$HERE"
fi
exec "$CUDIA_LOCAL_BIN" "$@"
