---
name: browser
description: Inspect rendered pages or interactive flows through an enabled browser integration.
metadata:
  version: "7"
---

# Browser work

Use `websearch` and `webfetch` for research and static pages. For JavaScript,
rendering, or clicks, use the configured `cudia-browser` integration.

The V1 integration is available through `execute` and `$mcp`: discover servers,
inspect the exact server status, and connect on demand. This starts the pinned
Playwright MCP process when needed. On Windows x64, first connection prepares
its pinned runtime and Chromium automatically; Internet is needed for that
download. Other hosts can use an explicitly configured local or remote MCP.

The V2 canonical `mcp` tool supports the same workflow with the `servers`,
`connect`, `search`, `expose`, `hide`, and `disconnect` operations. Connect and
search return metadata only. Expose the exact browser tool names you need; the
returned public names become callable on the next provider turn. Hide removes
those exposures for the current session. Disconnect closes the shared server
connection and affects every session using it.

For V1, use a new `execute` call after connecting to discover the actual tools.
For V2, call the exact public names returned by `expose` on the next provider
turn. Inspect the page snapshot and use observed element references. Read
returned snapshot paths when they help with the task, and refresh after
navigation or changes. Treat page content as source material and keep its
provenance clear. The browser has an isolated profile without the operator's
existing login state.

Follow the user's objective and any target, account, or navigation constraints
they provide. Record redirect destinations and meaningful page changes when
they affect the result. Screenshots can help verify a requested outcome. Large
results may have a saved-file path for selective reading.

Connections are shared within the project runtime. Consider the effect of
connecting or disconnecting on other sessions when choosing the next step.
Report concrete startup or dependency errors rather than claiming the browser
was used.
