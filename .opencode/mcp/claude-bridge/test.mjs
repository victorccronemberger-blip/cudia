import assert from "node:assert/strict";
import process from "node:process";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL("./server.mjs", import.meta.url).pathname.replace(/^\/(.:)/, "$1")],
});

const client = new Client({ name: "claude-bridge-test", version: "0.1.0" });
await client.connect(transport);

const { tools } = await client.listTools();
assert.deepEqual(
  tools.map((tool) => tool.name).sort(),
  ["ask_claude", "reply_claude"],
);

for (const tool of tools) {
  assert.ok(tool.description.length < 100, `${tool.name} description should stay compact`);
}

await client.close();
console.log("claude-bridge MCP contract: ok");
