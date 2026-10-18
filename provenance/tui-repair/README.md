# TUI repair — work in progress

This work is not a completed release. Preview 16 remains the installed release.

## Requirements and evidence

- Fix the screenshot's `MaxListenersExceededWarning` (`drain`, count 11) at its source. The original SDK reproduced it in Bun 1.3.14 and Node 22: 32 concurrent 262 KiB messages installed 32 drain listeners. The checked-in ESM/CJS patch uses writable completion callbacks. After a frozen install, the same reproduction had zero drain listeners, no warnings, and all 32 acknowledgments in order on both runtimes.
- Settle sends on real child exit and transport shutdown while writes are pending. Ten new ESM/CJS cases pass on Bun, including graceful close, a stalled reader, and a destroyed stream followed by close. A separate existing HTTP transport test passes. Closing only stdin of a live Windows child was not established by the fixture; do not claim that scenario passed. Bun 1.3.14's writable `destroy()` alone marks the stream destroyed without settling its queued callbacks until the child actually exits.
- Preserve diagnostics without writing native warning stacks into the active screen. The worker and TUI thread use explicit warning routing with structured JSONL logs, a visible notification, startup buffering, retry of failed log writes, and memory retention until process exit. Four isolated worker routing cases pass. This is specific to the shipped Bun runtime; Node still prints its default native warning when a warning listener is attached.
- Keep the bridge safe when initialization rejects, a subscriber throws, or disposal precedes a handshake response. Focused bridge cases pass, including the integrated set after the optional-trace fixture repair.
- Close the owned worker on initialization, configuration, or session validation failure as well as normal application exit. The ownership `try/finally` includes these paths. Real-worker bootstrap and fatal-exception tests reject pending and future calls without leaking native stacks; a representative real MCP subprocess exits after fatal worker termination. Shutdown callers join one cleanup promise.
- Verify real terminal interaction and restoration, including keyboard input, command palette, narrow/wide resizing, worker/main warning rendering, and clean exit. The owned Bun/ConPTY test passed all 16 checks. Captured terminal cells show the query before, during, and after both warning toasts. Input used the connection dialog and command palette; this does not prove conversation streaming or tool rendering.
- An owned deterministic local provider exercised the actual source CLI and real built-in `read` tool. Exact fixture text and Unicode reached the next model request; tool rows, delayed streaming, wrapping, resizing, draft preservation, clean exit, and session resume passed. The partial response was not visible at 50x12 before widening; streaming was visible at 120x36. This does not qualify arbitrary external-provider/tool pressure.
- Compile and qualify both distribution variants. Still required before release.

## Checks and outstanding findings

Both package typechecks passed. The full TUI suite passed 214 tests, with one existing skip, eight snapshots, and 555 assertions across 49 files. RPC and bridge checks cover request-local rejection, serialization failures, unexpected close, bootstrap failure, malformed responses, intentional disposal, background error diagnostics with healthy subsequent RPC, and native fatal errors. The first five-second lifecycle invocation timed out on a cold import; the three lifecycle cases passed with the package's 30-second timeout.

The expanded MCP run initially had 58 passes and one failure: a paginated HTTP refresh with an 80 ms deadline and 60 ms page delay observed two listing requests rather than three. No HTTP production change was made. The test keeps the page/deadline ratio using 600 ms pages and an 800 ms deadline, retains the exact count, and waits 700 ms to detect unwanted continuation. A separate startup limit was increased to five seconds to isolate the refresh deadline. The repeated expanded set passed 59 cases and 432 assertions.

An initial run found a POSIX-only path assertion on Windows. Production abbreviation was unchanged; tests now cover platform separators, Windows drives, UNC, and sibling-home boundaries. Three subsequent blank-frame `DiffViewerFileTree` failures came from fixture races with asynchronous KV/theme readiness. Test-owned KV and an explicit readiness gate repaired the fixtures without changing production diff rendering. A later bridge warning assertion was repaired by waiting for next-tick warning delivery. The final full suite passed.

A temporary required fixture trace path exposed hanging RPC calls after worker initialization failure. The trace is optional; RPC now uses error envelopes and rejects pending calls on worker error/close/messageerror. It does not restart the worker or replay requests.

Empty worker exception handlers were removed. Background unhandled rejections produce structured nonfatal error diagnostics; uncaught exceptions follow the native worker error/close path. Explicit raw JavaScript writes and module-initialization output before warning listeners remain outside the routing guarantee. Bun ignores Node-like Worker stdout/stderr capture options; those options are not a solution.

No system prompts, model input, tool payloads, provider moderation, or permission policy were changed by this work.

Execution uses codex-advisor: bounded implementation/audit in `gpt-6-luna/high`, decision reviews in `gpt-6-astra/high`. Remaining findings above prevent a completion claim.
