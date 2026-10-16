import { appendFile } from "node:fs/promises"
import readline from "node:readline"

const trace = process.env.CUDIA_MCP_TRACE
if (!trace) throw new Error("CUDIA_MCP_TRACE is required")

const record = async (value) => appendFile(trace, `${JSON.stringify(value)}\n`, "utf8")
await record({ event: "startup", pid: process.pid })

const tools = [
  {
    name: "echo",
    description: "Return the supplied fixture value.",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  },
]

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of input) {
  if (!line.trim()) continue
  const message = JSON.parse(line)
  await record({ method: message.method, params: message.params })
  if (!Object.hasOwn(message, "id")) continue

  let result = {}
  if (message.method === "initialize") {
    result = {
      protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "cudia-mcp-demand-fixture", version: "1.0.0" },
      instructions: "MCP_DEMAND_GUIDANCE_MARKER",
    }
  }
  if (message.method === "tools/list") result = { tools }
  if (message.method === "tools/call") {
    result = {
      content: [{ type: "text", text: `MCP_DEMAND_ECHO:${String(message.params?.arguments?.value)}` }],
    }
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`)
}
