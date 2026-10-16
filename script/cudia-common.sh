# Shared functions for cudia's POSIX launchers (Linux, macOS and Git Bash).

cudia_fail() {
  printf 'cudia: %s\n' "$*" >&2
  exit 1
}

cudia_checkout() {
  command -v git >/dev/null 2>&1 || cudia_fail "Git is required."
  [ -f "$1/packages/opencode/script/build.ts" ] && [ -f "$1/bun.lock" ] ||
    cudia_fail "Not a cudia checkout: $1"
  CUDIA_PREFIX=$(git -C "$1" rev-parse --show-prefix) || cudia_fail "Not a Git checkout: $1"
  [ "$CUDIA_PREFIX" = "" ] ||
    cudia_fail "Expected a Git checkout root: $1"
}

cudia_platform() {
  case "$(uname -s)" in
    Linux) CUDIA_PLATFORM=linux; CUDIA_EXE= ;;
    Darwin) CUDIA_PLATFORM=darwin; CUDIA_EXE= ;;
    MINGW*|MSYS*|CYGWIN*) CUDIA_PLATFORM=windows; CUDIA_EXE=.exe ;;
    *) cudia_fail "Unsupported platform. Use Linux, macOS or Git Bash on Windows." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) CUDIA_ARCH=x64 ;;
    aarch64|arm64) CUDIA_ARCH=arm64 ;;
    *) cudia_fail "Unsupported CPU architecture: $(uname -m)" ;;
  esac
  CUDIA_BASELINE_FLAG=
  CUDIA_BASELINE_SUFFIX=
  case "${CUDIA_BASELINE:-0}" in
    0|"") ;;
    1)
      [ "$CUDIA_ARCH" = x64 ] || cudia_fail "CUDIA_BASELINE=1 only applies to x64 CPUs."
      CUDIA_BASELINE_FLAG=--baseline
      CUDIA_BASELINE_SUFFIX=-baseline
      ;;
    *) cudia_fail "CUDIA_BASELINE must be 0 or 1." ;;
  esac
  CUDIA_BUILD_DIR=${CUDIA_BUILD_DIR:-dist}
  case "$CUDIA_BUILD_DIR" in
    dist) ;;
    dist-?*)
      case "$CUDIA_BUILD_DIR" in *[!A-Za-z0-9_-]*) cudia_fail "CUDIA_BUILD_DIR must be dist or dist-<name>." ;; esac
      ;;
    *) cudia_fail "CUDIA_BUILD_DIR must be dist or dist-<name>." ;;
  esac
  CUDIA_LOCAL_BIN=$1/packages/opencode/$CUDIA_BUILD_DIR/opencode-$CUDIA_PLATFORM-$CUDIA_ARCH$CUDIA_BASELINE_SUFFIX/bin/opencode$CUDIA_EXE
  CUDIA_BUILD_STAMP=$1/packages/opencode/$CUDIA_BUILD_DIR/.cudia-build
}

cudia_fingerprint() {
  cudia_checkout "$1"
  # Include staged, unstaged and untracked source edits. Documentation and harness
  # prompts can change without rebuilding, because OpenCode reads those at runtime.
  CUDIA_HEAD=$(git -C "$1" rev-parse HEAD) || cudia_fail "Cannot read checkout revision."
  CUDIA_TRACKED=$(git -C "$1" ls-files -s -- packages patches script package.json bun.lock) || cudia_fail "Cannot read tracked source files."
  CUDIA_DIFF=$(git -C "$1" diff --binary -- packages patches script package.json bun.lock) || cudia_fail "Cannot read source changes."
  # Hash the NUL-delimited paths separately; moving identical content must also
  # invalidate the build, and paths may contain whitespace or newlines.
  CUDIA_UNTRACKED_PATHS=$(git -C "$1" ls-files --others --exclude-standard -z -- packages patches script package.json bun.lock |
    git -C "$1" hash-object --stdin) || cudia_fail "Cannot read untracked source paths."
  CUDIA_UNTRACKED=$(
    cd -- "$1"
    git ls-files --others --exclude-standard -z -- packages patches script package.json bun.lock |
      xargs -0 git hash-object --
  ) || cudia_fail "Cannot read untracked source files."
  CUDIA_FINGERPRINT=$(printf '%s\n' "$CUDIA_HEAD" "$CUDIA_TRACKED" "$CUDIA_DIFF" "$CUDIA_UNTRACKED_PATHS" "$CUDIA_UNTRACKED" |
    git -C "$1" hash-object --stdin) || cudia_fail "Cannot fingerprint the checkout."
}

cudia_build() {
  cudia_checkout "$1"
  command -v bun >/dev/null 2>&1 || cudia_fail "Bun is required to build this checkout; see package.json for the required version."
  cudia_platform "$1"
  # Invalidate before any operation that can fail. A previous binary is never a
  # substitute for a failed update or a source edit that has not been compiled.
  rm -f -- "$CUDIA_BUILD_STAMP"
  printf '==> installing workspace dependencies...\n' >&2
  (cd -- "$1" && bun install --frozen-lockfile)
  cudia_fingerprint "$1"
  CUDIA_BUILT_FINGERPRINT=$CUDIA_FINGERPRINT
  CUDIA_ENGINE_VERSION=$(cd -- "$1" && bun -e 'console.log((await Bun.file("packages/opencode/package.json").json()).version)')
  CUDIA_COMMIT=$(git -C "$1" rev-parse --short=12 HEAD)
  CUDIA_VERSION=$CUDIA_ENGINE_VERSION+cudia.$CUDIA_COMMIT.$(printf '%s' "$CUDIA_FINGERPRINT" | cut -c1-12)
  printf '==> building cudia %s...\n' "$CUDIA_VERSION" >&2
  (
    cd -- "$1/packages/opencode"
    OPENCODE_CHANNEL=cudia OPENCODE_VERSION="$CUDIA_VERSION" \
      bun run script/build.ts --single --output-dir "$CUDIA_BUILD_DIR" --skip-install --skip-embed-web-ui ${CUDIA_BASELINE_FLAG:+"$CUDIA_BASELINE_FLAG"}
  )
  [ -x "$CUDIA_LOCAL_BIN" ] || cudia_fail "Build did not produce $CUDIA_LOCAL_BIN"
  "$CUDIA_LOCAL_BIN" --version >/dev/null
  # An editor or another update may change source while the compiler is running.
  cudia_fingerprint "$1"
  [ "$CUDIA_FINGERPRINT" = "$CUDIA_BUILT_FINGERPRINT" ] ||
    cudia_fail "Sources changed while building; run cudia again to rebuild."
  printf '%s\n' "$CUDIA_FINGERPRINT" > "$CUDIA_BUILD_STAMP"
}
