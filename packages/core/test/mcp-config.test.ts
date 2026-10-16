import { expect, test } from "bun:test"
import { Config } from "@opencode-ai/core/config"
import { ConfigMCP } from "@opencode-ai/core/config/mcp"
import { MCPConfig } from "@opencode-ai/core/mcp/config"

test("MCP configuration preserves other servers and applies nearest definitions and per-field timeouts", () => {
  const global = new Config.Document({
    type: "document",
    info: new Config.Info({
      mcp: new ConfigMCP.Info({
        timeout: new ConfigMCP.Timeout({ startup: 120_000, request: 5_000 }),
        servers: {
          browser: new ConfigMCP.Local({ type: "local", command: ["old-browser"], disabled: true }),
          docs: new ConfigMCP.Remote({ type: "remote", url: "http://localhost/docs", oauth: false }),
        },
      }),
    }),
  })
  const local = new Config.Document({
    type: "document",
    info: new Config.Info({
      mcp: new ConfigMCP.Info({
        timeout: new ConfigMCP.Timeout({ request: 60_000 }),
        servers: { browser: new ConfigMCP.Local({ type: "local", command: ["new-browser"], disabled: false }) },
      }),
    }),
  })
  const resolved = MCPConfig.resolve([global, local])
  expect(resolved.servers.get("browser")).toMatchObject({ command: ["new-browser"], disabled: false })
  expect(resolved.servers.get("docs")).toMatchObject({ url: "http://localhost/docs", oauth: false })
  expect(resolved.timeout).toEqual({ startup: 120_000, request: 60_000 })
  expect(MCPConfig.resolve([]).servers.size).toBe(0)
})

test("MCP configuration treats prototype-like names as configured data", () => {
  const servers = Object.fromEntries([
    ["__proto__", new ConfigMCP.Local({ type: "local", command: ["fixture"] })],
    ["constructor", new ConfigMCP.Local({ type: "local", command: ["second-fixture"] })],
  ])
  const resolved = MCPConfig.resolve([
    new Config.Document({ type: "document", info: new Config.Info({ mcp: new ConfigMCP.Info({ servers }) }) }),
  ])
  expect([...resolved.servers.keys()]).toEqual(["__proto__", "constructor"])
  expect(resolved.servers.get("__proto__")).toMatchObject({ command: ["fixture"] })
})
