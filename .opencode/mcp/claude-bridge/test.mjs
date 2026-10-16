import assert from "node:assert/strict";
import process from "node:process";
import { mkdtemp, readFile, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const config = JSON.parse(await readFile(new URL("../../opencode.json", import.meta.url), "utf8"));
const cwd = await mkdtemp(join(tmpdir(), "cudia bridge "));
const client = new Client({ name: "claude-bridge-test", version: "0.1.0" });
try {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: config.mcp["claude-bridge"].command.slice(1),
    cwd,
    env: { ...process.env, OPENCODE_CONFIG_DIR: fileURLToPath(new URL("../../", import.meta.url)) },
  });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["ask_claude", "reply_claude"]);
  for (const tool of tools) {
    assert.ok(tool.description.length < 100, `${tool.name} description should stay compact`);
  }
} finally {
  await client.close();
  await rmdir(cwd);
}
console.log("claude-bridge MCP contract: ok");
