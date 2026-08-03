#!/usr/bin/env bash
# cudia launcher — starts opencode with the cudia harness config loaded.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
exec opencode "$@"
