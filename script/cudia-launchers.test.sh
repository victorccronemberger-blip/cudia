#!/usr/bin/env sh
# Exercises the actual launchers against disposable Git repos and a fake toolchain.
# No dependency install, network access, or changes to the user's installation.
set -eu
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) export MSYS="${MSYS:+$MSYS }winsymlinks:lnk" ;; esac

SOURCE=$(CDPATH= cd -P -- "$(dirname -- "$0")/.." && pwd)
TEST_PARENT=$(CDPATH= cd -P -- "${TMPDIR:-/tmp}" && pwd)
TEST_ROOT=$(mktemp -d "$TEST_PARENT/cudia-launchers.XXXXXX")
TEST_ROOT=$(CDPATH= cd -P -- "$TEST_ROOT" && pwd)
cleanup() {
  # Confirm the absolute target is the disposable directory created above.
  case "$TEST_ROOT" in "$TEST_PARENT"/cudia-launchers.*) rm -rf -- "$TEST_ROOT" ;; esac
}
trap cleanup EXIT HUP INT TERM
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }

mkdir -p "$TEST_ROOT/tools" "$TEST_ROOT/home/.local/share/opencode" "$TEST_ROOT/checkout with spaces/packages/opencode/script" "$TEST_ROOT/checkout with spaces/script" "$TEST_ROOT/project" "$TEST_ROOT/bin"
REPO=$TEST_ROOT/checkout\ with\ spaces
cp "$SOURCE/run.sh" "$SOURCE/install.sh" "$SOURCE/update.sh" "$SOURCE/remove.sh" "$REPO/"
cp "$SOURCE/script/cudia-common.sh" "$REPO/script/"
printf '{"version":"1.18.35"}\n' > "$REPO/packages/opencode/package.json"
printf '{}\n' > "$REPO/package.json"
printf '{}\n' > "$REPO/bun.lock"
printf '// fixture source\n' > "$REPO/packages/opencode/script/build.ts"
printf 'dist/\nnode_modules/\n' > "$REPO/.gitignore"
printf 'session history\n' > "$TEST_ROOT/home/.local/share/opencode/sessions.db"
git -C "$REPO" init -q
git -C "$REPO" config user.name 'Launcher Test'
git -C "$REPO" config user.email 'launcher-test@example.invalid'
git -C "$REPO" config core.fileMode false
git -C "$REPO" config core.autocrlf false
git -C "$REPO" add .
git -C "$REPO" commit -qm 'fixture'

# Only fake Bun and platform detection: the launcher, Git, shell, symlinks and
# file operations are real. A real dependency install would defeat test isolation.
cat > "$TEST_ROOT/tools/uname" <<'EOF'
#!/usr/bin/env sh
case "$1" in -s) printf '%s\n' "${CUDIA_TEST_OS:-Linux}" ;; -m) printf '%s\n' "${CUDIA_TEST_ARCH:-x86_64}" ;; esac
EOF
cat > "$TEST_ROOT/tools/bun" <<'EOF'
#!/usr/bin/env sh
set -eu
printf '%s\n' "$*" >> "$CUDIA_TEST_LOG"
case "$1" in
  install)
    [ "$*" = 'install --frozen-lockfile' ] || exit 91
    exit "${CUDIA_TEST_INSTALL_STATUS:-0}"
    ;;
  -e) printf '1.18.35\n' ;;
  run)
    [ "${CUDIA_TEST_BUILD_STATUS:-0}" = 0 ] || exit "$CUDIA_TEST_BUILD_STATUS"
    [ "$OPENCODE_CHANNEL" = cudia ] || exit 92
    case "$OPENCODE_VERSION" in 1.18.35+cudia.*) ;; *) exit 93 ;; esac
    mkdir -p dist/opencode-linux-x64/bin
    cat > dist/opencode-linux-x64/bin/opencode <<'BIN'
#!/usr/bin/env sh
if [ "${1:-}" = --version ]; then printf '1.18.35+cudia.test\n'; exit 0; fi
printf 'cwd=%s\nconfig=%s\ndb=%s\ncode-mode=%s\ncontext-mode=%s\nweb-search=%s\n' "$PWD" "$OPENCODE_CONFIG_DIR" "$OPENCODE_DISABLE_CHANNEL_DB" "$OPENCODE_EXPERIMENTAL_CODE_MODE" "$CUDIA_CONTEXT_MODE" "$OPENCODE_ENABLE_EXA" > "$CUDIA_TEST_OUTPUT"
printf 'arg=%s\n' "$@" >> "$CUDIA_TEST_OUTPUT"
BIN
    if command -v chmod >/dev/null 2>&1; then chmod +x dist/opencode-linux-x64/bin/opencode; fi
    if [ "${CUDIA_TEST_MUTATE_SOURCE:-0}" = 1 ]; then printf '// concurrent edit\n' >> script/build.ts; fi
    ;;
  *) exit 94 ;;
esac
EOF
cat > "$TEST_ROOT/tools/opencode" <<'EOF'
#!/usr/bin/env sh
printf 'unexpected global fallback\n' >> "$CUDIA_TEST_OUTPUT"
exit 99
EOF
if command -v chmod >/dev/null 2>&1; then chmod +x "$TEST_ROOT/tools/"*; fi
export PATH="$TEST_ROOT/tools:$PATH"
export HOME="$TEST_ROOT/home"
export CUDIA_DIR="$REPO"
export CUDIA_BIN_DIR="$TEST_ROOT/bin"
export CUDIA_TEST_LOG="$TEST_ROOT/tool.log"
export CUDIA_TEST_OUTPUT="$TEST_ROOT/launched.txt"
SH=${CUDIA_TEST_SH:-sh}

CUDIA_TEST_OS=MINGW64_NT-10.0 CUDIA_TEST_ARCH=aarch64 "$SH" -c '
  . "$1"
  cudia_platform "$2"
  [ "$CUDIA_LOCAL_BIN" = "$2/packages/opencode/dist/opencode-windows-arm64/bin/opencode.exe" ]
' sh "$REPO/script/cudia-common.sh" "$REPO" || fail 'Windows target detection'
CUDIA_BASELINE=1 "$SH" -c '
  . "$1"
  cudia_platform "$2"
  [ "$CUDIA_LOCAL_BIN" = "$2/packages/opencode/dist/opencode-linux-x64-baseline/bin/opencode" ]
  [ "$CUDIA_BASELINE_FLAG" = --baseline ]
' sh "$REPO/script/cudia-common.sh" "$REPO" || fail 'baseline target detection'
pass 'Windows arm64 and x64 baseline target detection'

CUDIA_BUILD_DIR=dist-preview "$SH" -c '
  . "$1"
  cudia_platform "$2"
  [ "$CUDIA_LOCAL_BIN" = "$2/packages/opencode/dist-preview/opencode-linux-x64/bin/opencode" ]
  [ "$CUDIA_BUILD_STAMP" = "$2/packages/opencode/dist-preview/.cudia-build" ]
' sh "$REPO/script/cudia-common.sh" "$REPO" || fail 'alternate artifact directory'
if CUDIA_BUILD_DIR=../outside "$SH" -c '. "$1"; cudia_platform "$2"' sh "$REPO/script/cudia-common.sh" "$REPO" >/dev/null 2>&1; then fail 'unsafe artifact directory accepted'; fi
pass 'bounded alternate artifact directory'

# Missing build compiles with frozen dependencies and version provenance.
cd "$TEST_ROOT/project"
"$SH" "$REPO/run.sh" 'argument with spaces' '--model=example/model'
grep -Fx "cwd=$TEST_ROOT/project" "$CUDIA_TEST_OUTPUT" >/dev/null || fail 'project directory changed'
grep -Fx "config=$REPO/.opencode" "$CUDIA_TEST_OUTPUT" >/dev/null || fail 'harness was not loaded'
grep -Fx 'db=1' "$CUDIA_TEST_OUTPUT" >/dev/null || fail 'session database changed'
grep -Fx 'code-mode=1' "$CUDIA_TEST_OUTPUT" >/dev/null || fail 'MCP discovery not enabled by default'
grep -Fx 'context-mode=lean' "$CUDIA_TEST_OUTPUT" >/dev/null || fail 'lean context not enabled by default'
grep -Fx 'web-search=1' "$CUDIA_TEST_OUTPUT" >/dev/null || fail 'web search not enabled for custom providers'
grep -Fx 'arg=argument with spaces' "$CUDIA_TEST_OUTPUT" >/dev/null || fail 'arguments were split'
pass 'custom build, version provenance, config, database and arguments'

OPENCODE_EXPERIMENTAL_CODE_MODE=0 "$SH" "$REPO/run.sh"
grep -Fx 'code-mode=0' "$CUDIA_TEST_OUTPUT" >/dev/null || fail 'explicit MCP discovery override ignored'
pass 'MCP discovery default and explicit opt-out'

CUDIA_CONTEXT_MODE=standard "$SH" "$REPO/run.sh"
grep -Fx 'context-mode=standard' "$CUDIA_TEST_OUTPUT" >/dev/null || fail 'explicit context mode override ignored'
pass 'lean context default and explicit compatibility mode'

OPENCODE_ENABLE_EXA=0 "$SH" "$REPO/run.sh"
grep -Fx 'web-search=0' "$CUDIA_TEST_OUTPUT" >/dev/null || fail 'explicit web search override ignored'
pass 'web search default and explicit opt-out'

BUILD_COUNT=$(grep -c '^run ' "$CUDIA_TEST_LOG")
"$SH" "$REPO/run.sh"
[ "$(grep -c '^run ' "$CUDIA_TEST_LOG")" = "$BUILD_COUNT" ] || fail 'fresh binary rebuilt'
printf '// edited\n' >> "$REPO/packages/opencode/script/build.ts"
"$SH" "$REPO/run.sh"
[ "$(grep -c '^run ' "$CUDIA_TEST_LOG")" = "$((BUILD_COUNT + 1))" ] || fail 'changed source used stale binary'
printf '// untracked source\n' > "$REPO/packages/opencode/new.ts"
"$SH" "$REPO/run.sh"
[ "$(grep -c '^run ' "$CUDIA_TEST_LOG")" = "$((BUILD_COUNT + 2))" ] || fail 'untracked source used stale binary'
pass 'fresh binary reused and tracked/untracked source edits rebuilt'

mv "$REPO/packages/opencode/new.ts" "$REPO/packages/opencode/renamed source.ts"
"$SH" "$REPO/run.sh"
[ "$(grep -c '^run ' "$CUDIA_TEST_LOG")" = "$((BUILD_COUNT + 3))" ] || fail 'renamed untracked source used stale binary'
pass 'renaming unchanged untracked source to a path with spaces rebuilds'

rm -f "$CUDIA_TEST_OUTPUT"
printf '// needs rebuilding\n' >> "$REPO/packages/opencode/script/build.ts"
export CUDIA_TEST_BUILD_STATUS=31
if "$SH" "$REPO/run.sh" > "$TEST_ROOT/failure.txt" 2>&1; then fail 'failed build returned success'; fi
[ ! -e "$CUDIA_TEST_OUTPUT" ] || fail 'failed build launched an obsolete binary'
[ ! -e "$REPO/packages/opencode/dist/.cudia-build" ] || fail 'failed build kept a valid stamp'
unset CUDIA_TEST_BUILD_STATUS
export CUDIA_TEST_INSTALL_STATUS=32
if "$SH" "$REPO/install.sh" > "$TEST_ROOT/failure.txt" 2>&1; then fail 'failed install returned success'; fi
[ ! -e "$TEST_ROOT/bin/cudia" ] || fail 'failed install created a launcher'
unset CUDIA_TEST_INSTALL_STATUS
pass 'build and dependency failures propagate without stale fallback'

export CUDIA_TEST_MUTATE_SOURCE=1
if "$SH" "$REPO/run.sh" > "$TEST_ROOT/failure.txt" 2>&1; then fail 'concurrent source change produced a valid build'; fi
[ ! -e "$CUDIA_TEST_OUTPUT" ] || fail 'concurrent source change launched stale code'
[ ! -e "$REPO/packages/opencode/dist/.cudia-build" ] || fail 'concurrent source change was stamped as current'
unset CUDIA_TEST_MUTATE_SOURCE
pass 'source changes during compilation cannot validate a stale binary'

if "$SH" "$REPO/update.sh" > "$TEST_ROOT/failure.txt" 2>&1; then fail 'update accepted local edits'; fi
grep -F '// needs rebuilding' "$REPO/packages/opencode/script/build.ts" >/dev/null || fail 'update clobbered local edits'
git -C "$REPO" add .
git -C "$REPO" commit -qm 'local custom source'
git init -q --bare "$TEST_ROOT/remote.git"
git -C "$REPO" remote add origin "$TEST_ROOT/remote.git"
git -C "$REPO" push -qu origin HEAD
git -c core.autocrlf=false clone -q "$TEST_ROOT/remote.git" "$TEST_ROOT/publisher"
git -C "$TEST_ROOT/publisher" config user.name 'Launcher Test'
git -C "$TEST_ROOT/publisher" config user.email 'launcher-test@example.invalid'
git -C "$TEST_ROOT/publisher" config core.autocrlf false
printf '// newer upstream\n' >> "$TEST_ROOT/publisher/packages/opencode/script/build.ts"
git -C "$TEST_ROOT/publisher" add .
git -C "$TEST_ROOT/publisher" commit -qm 'engine update'
git -C "$TEST_ROOT/publisher" push -q
"$SH" "$REPO/update.sh"
grep -F '// newer upstream' "$REPO/packages/opencode/script/build.ts" >/dev/null || fail 'update did not fast forward'
"$SH" "$REPO/run.sh"
pass 'update refuses local edits and rebuilds a real fast-forward pull'

# Symlinks resolve relative to each link, without GNU readlink -f.
ln -s '../checkout with spaces/run.sh' "$TEST_ROOT/bin/relative"
ln -s relative "$TEST_ROOT/bin/nested"
"$SH" "$TEST_ROOT/bin/nested" 'via symlink'
grep -Fx "config=$REPO/.opencode" "$CUDIA_TEST_OUTPUT" >/dev/null || fail 'relative symlink lost checkout'
pass 'relative and chained symlink resolution'

"$SH" "$REPO/install.sh"
[ -L "$TEST_ROOT/bin/cudia" ] || fail 'install did not register launcher'
"$SH" "$REPO/remove.sh" --yes
[ ! -e "$TEST_ROOT/bin/cudia" ] || fail 'launcher was not removed'
[ -d "$REPO/.git" ] || fail 'remove deleted checkout'
grep -Fx 'session history' "$TEST_ROOT/home/.local/share/opencode/sessions.db" >/dev/null || fail 'remove deleted sessions'
printf 'unrelated file\n' > "$TEST_ROOT/bin/cudia"
if "$SH" "$REPO/install.sh" > "$TEST_ROOT/failure.txt" 2>&1; then fail 'install replaced unrelated file'; fi
if "$SH" "$REPO/remove.sh" --yes > "$TEST_ROOT/failure.txt" 2>&1; then fail 'remove deleted unrelated file'; fi
grep -Fx 'unrelated file' "$TEST_ROOT/bin/cudia" >/dev/null || fail 'launcher conflict destroyed data'
pass 'install/remove preserve checkout, sessions and unrelated files'
