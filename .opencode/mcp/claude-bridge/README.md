# Claude Code consultation bridge

This optional MCP server exposes `ask_claude` and `reply_claude` for independent
analysis and review in the current workspace. It is disabled by default in
the cudia configuration.

Workspace installation includes this server's Node dependencies. Install and
authenticate Claude Code separately, then set `mcp.claude-bridge.enabled` to
`true` in `.opencode/opencode.json` when you want to use it. `CLAUDE_CLI_PATH`
can select an executable instead of `claude` from `PATH`.

The bridge runs Claude in read-only mode for consultation. It disables
nested MCP servers to prevent recursion, removes API
and third-party provider overrides from the child environment, and exposes only
`Read`, `Glob`, and `Grep` to Claude.

The configured startup command resolves the server under
`OPENCODE_CONFIG_DIR`, which the cudia launcher supplies, while retaining the
operator's working directory for the consultation. This also handles native
Windows paths without inserting them into JSON configuration text. If starting
OpenCode directly, supply that environment variable or run from this checkout.

## Validation

Run `node test.mjs` from this directory. The contract test checks the configured
startup command and tool catalog from another working directory, without
calling Claude's service. Restart the client after changing MCP configuration.

Service access, model behavior, quotas, and billing remain governed by the
Claude account and CLI. The bridge does not configure those services.
