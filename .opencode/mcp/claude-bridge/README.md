# Codex + Claude Code collaboration

This setup connects the two subscription-authenticated CLIs in both directions:

- Claude Code sees Codex through the official `codex mcp-server` command.
- Codex sees Claude through the local `claude-collab` MCP bridge.

The reverse bridge deliberately runs Claude in safe, read-only mode. It disables
all nested MCP servers to prevent Codex -> Claude -> Codex recursion, removes API
and third-party provider overrides from the child environment, and exposes only
`Read`, `Glob`, and `Grep` to Claude.

## Tools

- In Claude Code: `mcp__codex__codex` and `mcp__codex__codex-reply`.
- In Codex: `ask_claude` and `reply_claude` from the `claude-collab` server.

Restart an already-open client after changing MCP configuration. Use `/mcp` in
Claude Code or `codex mcp list` to inspect connection state.

## Billing note

Both CLIs are authenticated with their consumer subscriptions. Claude's
non-interactive `-p` mode can draw from the separate Agent SDK allowance attached
to a Claude subscription; it does not use an Anthropic API key in this bridge.
