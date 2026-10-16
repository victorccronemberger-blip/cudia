# Cudia native Windows launcher (increment)

This stdlib-only Go module supplies the native bootstrap, versioned launcher, signed bundle installation, explicit HTTPS updates and verified local rollback. Installed execution requires no Git, Bun, Node or .NET. Development builds require Go 1.27 with `CGO_ENABLED=0` and `GOTOOLCHAIN=local`.

This module supplies the native coordinator used by the surrounding compiled Inno wizard, including user PATH and Apps/uninstaller registration. Silent installation, intact-install rerun, uninstall and interactive/cancellation QA passed with a real engine and isolated Registry destinations. Signed Preview installers are public, and live HTTPS updates at cyara.com.br passed from sequence 1 to 2 and then 2 to 3. Clean Windows, stable qualification, Authenticode and offsite key recovery remain pending. The surrounding CUDIA engine implements `CUDIA_DISTRIBUTION_DIR`; source and compiled tests verify its read-only defaults and configuration precedence. Defining that variable alone does not implement packaged defaults in an arbitrary unmodified engine. See the [Windows distribution tests](../README.md#validação) for composed bootstrap, real-engine and old-server update checks.

The maintenance backend exposes prepared installation tickets, commit/abort recovery, conservative user-PATH ownership and inventory-based removal. A durable intent precedes internal preparation, so a rerun can recover its own interrupted preparation before the full wizard journal exists; mismatched or manually created transactions are preserved. Bootstrap and launcher hold shared lifetime leases through engine exit; removal requires an exclusive lease and checks legacy process images too. The [installer transaction contract](../INSTALLER-TRANSACTIONS.md) documents the commands, ownership and remaining gates. Registry tests use isolated HKCU keys and do not register this checkout in the operator's PATH.

Before the first uninstall deletion, the coordinator records the complete removal plan and registers a verified recovery helper outside the installation. Both uninstall commands remain usable through an interrupted removal, including after the original helper and activation are gone. Removal preserves unknown files, edited connections, user sessions and credentials. Final cleanup verifies the original root metadata and locks, then transfers external helper cleanup to a static System32 PowerShell 5 program with a bounded typed Registry journal. It verifies local canonical paths, file identity, hashes and empty directories; interrupted deletion retains a Registry-only retry command. The final key deletion removes the journal and commands together. CLI `*-started` status acknowledges the asynchronous handoff, while GUI success follows final cleanup. See the [maintenance contract](../INSTALLER-TRANSACTIONS.md#desinstalação-coordenada) for phase ordering and recovery limits.

## Installed layout and commands

```text
<root>/bin/cudia.exe                      stable bootstrap ABI 1
<root>/connection.json                    non-secret update connection settings
<root>/maintenance/launcher.exe           registered maintenance helper
<root>/state/activation.json              single activation commit point
<root>/state/update.lock                  OS-owned byte-range lock; never delete it
<root>/state/staging/update-<random>/       exclusive temporary work
<root>/versions/seq-<sequence>-<sha256>/
  launcher.exe
  runtime/engine.exe
  defaults/**
```

If selected in the wizard, the installer adds the absolute `<root>\bin` directory to the current user's PATH. Open a new terminal after PATH registration. No launcher script or working-directory change is involved: `cudia` forwards arbitrary arguments, stdin/stdout/stderr, the caller's current directory and the engine's exit status. It derives its installation root from its own executable, never from the caller's directory or an environment override.

- `cudia update --check` verifies the remote manifest and reports availability.
- `cudia update` downloads, verifies and stages a new immutable version, then selects it for future launches. It never overwrites the bootstrap or a running version.
- `cudia installation info` prints the activation history, root, bootstrap ABI and compiled trust digest/key count. Artifact URLs are not persisted in this state.
- `cudia rollback <verified-release-id>` selects an existing verified version without lowering the highest observed release sequence. Automatic network checks cannot reinstall a sequence at or below that high-water mark after rollback; another explicit local rollback can select retained history.
- The upstream engine's `upgrade` and `uninstall` commands are blocked with Cudia-specific guidance. Use `cudia update` for updates and Windows Installed apps/the Cudia installer for uninstall. This module itself deletes no user configuration or session history and performs no automatic old-version garbage collection.

Interactive console startup can check the signed manifest in the background when `automaticCheck` is true and the configured interval has elapsed (default 24 hours). New wizard connections enable it; existing connections and prepared legacy installation tickets retain their policy. Missing configuration and an empty compiled keyring disable automatic network checks. Help, version, maintenance commands and piped execution do not trigger them. The default manifest is `https://cyara.com.br/updates/v1/stable.json`.

The engine starts without waiting for the network response. Concurrent launchers share one ephemeral kernel mutex per installation; no polling process or disk lock is created. Engine exit cancels and joins the worker before releasing the launcher's lifetime lease. Failures back off for at least 24 hours; a cancelled request does not create a failure record. The interval is evaluated at interactive launches, so a continuously open session does not schedule periodic requests. Checks never download an archive or activate an update. A later interactive launch can display a verified cached notice directing the operator to `cudia update`.

The bounded 128 KiB `state/update-check.json` cache binds its result to the installation root, connection, compiled public keys, selected release, variant and sequence high-water mark. Every notice re-verifies the cached signed envelope against the current binding and expiry. Unknown fields, malformed content, hard links and reparse points cause preservation and suspend automatic checks. Writes use an owned temporary file and atomic replacement after identity/content revalidation under the mutex; this is not compare-and-swap against unrelated same-user editors. A crash may leave an unknown temporary file, which is preserved. Coordinated uninstall inventories only a structurally recognized cache belonging to that root and preserves unknown content at the same filename.

The versioned launcher sets `CUDIA_DISTRIBUTION_DIR` to its own version's `defaults` directory. It preserves existing user/project configuration and sets no `OPENCODE_CONFIG_DIR`. It supplies existing `run.sh` defaults only when the operator has not set them: `OPENCODE_DISABLE_CHANNEL_DB=1`, `OPENCODE_EXPERIMENTAL_CODE_MODE=1`, `CUDIA_CONTEXT_MODE=lean`, `OPENCODE_ENABLE_EXA=1`. It forces `OPENCODE_DISABLE_AUTOUPDATE=1` so the engine does not alter the managed distribution. Upstream engine help/branding still needs integration review.

Wrappers share the console, let the engine receive Ctrl+C and wait for its exit status. Downloads use interrupt cancellation. An actual Windows console-control-event test creates a hidden, separate console and proves its attached process list contains only its own driver/bootstrap/launcher/test-engine descendants before generating Ctrl+C there. The test engine catches the event and exits 23; both wrappers preserve that exit status. Automated tests never send console events to the user's session or touch the protected existing engine process. Interactive terminal rendering/input behavior with the production engine still needs manual review.

## Signed installation and trust

`internal/client/trust.json` is compiled into both build outputs. It is a JSON object mapping bounded key IDs to Ed25519 SPKI `PUBLIC KEY` PEM strings. The checked-in file is `{}`: normal engine dispatch works, but update checks clearly report that updates are disabled. No key is trusted from the network, `connection.json`, a CLI option or environment variables. Never place private keys here.

The outer build can copy this module to an owned temporary directory, replace only that copy's `internal/client/trust.json` with the operator's validated public keyring, and compile. `launcher.exe trust-info` validates the compiled keyring and prints `{schema,bootstrapABI,trustedKeys,trustSha256}` even before installation. This does not alter trust. Production Authenticode signing and the trusted installer/download ownership remain packaging responsibilities.

A wizard can run its trusted temporary launcher helper using absolute paths:

```powershell
launcher.exe install-bundled --root 'C:\Users\me\AppData\Local\Cudia' --manifest 'C:\bundle\stable.json' --archive 'C:\bundle\cudia.zip' --variant normal
```

The helper verifies the compiled-key signature over the decoded manifest payload, expiry/channel, archive size/hash, package identity, bootstrap ABI and every extracted file before initializing state. It also supports an existing installation subject to the same sequence rules. It never installs an unsigned local ZIP. Install `bin/cudia.exe` separately using the trusted installer; ordinary bundle updates never replace it. The future installer must use a separate bootstrap ABI maintenance path if ABI 1 is no longer supported.

## Protocol and filesystem constraints

The client follows `deploy/updates/lib/manifest.js`: envelope schema 1, canonical base64, Ed25519 over exact decoded payload bytes, payload schema 1/product `cudia`, UTC issue/expiry dates, safe integer sequence 1..9007199254740991, strict semver, channel stable/preview and archive selection by Windows/x64/normal-or-baseline. Integer-valued JSON Number spellings such as `1.0`/`1e0` retain the release service's JavaScript semantics; signatures always cover original bytes before typed decoding. UTC comparisons use the service's millisecond precision. It rejects unknown fields, duplicate object keys (including escaped aliases), invalid UTF-8, JSON deeper than 64, HTTPS credentials/fragments and duplicate artifact identities. Acquisition limits are 64 KiB for manifests, declared archive size up to 2 GiB, 15 seconds for manifest acquisition and five minutes for assets. TLS certificate validation remains enabled; redirects are capped at three and require HTTPS. HTTP bodies must be identity encoded, and actual streamed size/hash determine acceptance.

ZIPs contain only `package.json` and the descriptor's files, with no explicit directory entries. The exact descriptor fields are `schema`, `product`, `version`, `channel`, `sequence`, `platform`, `arch`, `variant`, `bootstrapABI`, `files`. `files` maps forward-slash relative names to exact `{size,sha256}` records. `launcher.exe` and `runtime/engine.exe` are mandatory nonempty MZ/PE32+ AMD64 executable images, checked with stdlib `debug/pe` before activation; DLLs are rejected. This structural compatibility gate does not promise that every signed engine build is functionally correct. All remaining files must be under `defaults/`. Caps: descriptor 1 MiB, at most 4096 payload files, each at most 512 MiB, total uncompressed payload at most 1 GiB. Traversal, absolute/UNC/backslash/ADS/device paths, trailing dots/spaces, links, nonregular entries, missing/extra/repeated/case-colliding names and corrupted payloads are rejected. Files are read to completion so archive/zip checks CRC as well as the descriptor hash. Null/non-number sizes are rejected.

All payload handles are closed/flushed before version promotion. State is flushed before `MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH)` replaces `activation.json`; promotion uses `MoveFileExW(WRITE_THROUGH)` without replacement. Readers consume one bounded, strict state document (8 MiB, at most 128 retained records). `LockFileEx` serializes installs/updates/rollback and releases automatically when its process exits or dies. Failed commits leave the old selected version. A retry re-verifies and reuses an unreferenced promoted version. No stale PID lock heuristics or old-version deletion are used.

Existing path ancestors and cleanup descendants are checked for Windows reparse points. Recursive cleanup accepts only a proper contained path under this installation's staging root. These checks prevent accidental traversal, but this per-user writable installation is not claimed to withstand a concurrent malicious process running as the same user; such a process can already change executable/state files. Local integrity checks detect accidental modification against persisted verified descriptors, not an independently signed local state authority.

## Validation

Run from this module directory:

```powershell
$env:CGO_ENABLED='0'
$env:GOTOOLCHAIN='local'
go test ./...
go vet ./...
go build -trimpath -o dist/cudia.exe ./cmd/bootstrap
go build -trimpath -o dist/launcher.exe ./cmd/launcher
```

Tests generate ephemeral signing keys only in memory. The real HTTPS test server certificate is explicitly added to a private test trust pool; tests use no `InsecureSkipVerify`. Coverage includes signed/expired/duplicate manifests, unsafe ZIPs, exact file hashes/caps, interrupted/cancelled/corrupt downloads, unchanged activation, sequence conflicts, rollback, lock contention/process-death release and an activation commit denied by Windows delete sharing. A native compiled **test helper engine**, clearly located at `internal/client/testdata/engine`, proves Unicode/space current directory, empty/quoted/trailing-backslash/Unicode arguments, exit code 37, operator environment preservation, PATH invocation without tool directories, an old running version surviving update, future dispatch to the new version, unchanged bootstrap bytes, and isolated-console Ctrl+C propagation with exact exit 23. The helper is not a Cudia engine or a production artifact.

The latest frozen-source run passed 130 top-level tests and 295 subtests, with no failed or skipped tests, plus `go vet ./...`. Both `cmd` packages report no test files. Coverage includes wizard interruption recovery, identity-based compensation, durable uninstall handoff/retry and a real process-exit race during inventory scanning. Automatic-check tests cover signed TLS responses, concurrent launchers, cancellation, backoff, connection/trust/activation changes, strict cache ownership and replacement failures. An installed bootstrap in a private console starts its test engine while the TLS server withholds the response; engine exit cancels that request, preserves activation and leaves the lifetime lease available. Its private build pins only the test CA and signing key; production TLS verification is unchanged. The compiled wizard test in the parent distribution directory separately verifies preservation of an idle real V2 session's SQLite/WAL/SHM bytes; no provider prompt is sent.
