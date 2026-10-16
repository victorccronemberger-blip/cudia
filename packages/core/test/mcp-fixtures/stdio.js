const fs = require("node:fs")
const readline = require("node:readline")

const args = process.argv.slice(2)
const hang = args.includes("--hang-initialize")
const marker = args.find((value) => value.startsWith("--pid-file="))?.slice("--pid-file=".length)
if (marker) fs.writeFileSync(marker, String(process.pid))

process.stderr.write("mcp fixture stderr ".repeat(20_000))

const server = {
  name: "fixture",
  version: "1.0.0",
}

const rl = readline.createInterface({ input: process.stdin })
rl.on("line", (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    process.exitCode = 1
    return
  }
  if (!message || typeof message !== "object" || !("id" in message)) return
  if (hang && message.method === "initialize") return

  const result =
    message.method === "initialize"
      ? { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: server }
      : message.method === "tools/list"
        ? {
            tools: [
              {
                name: "echo",
                description: "Echo a short value",
                inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
                outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
              },
            ],
          }
        : message.method === "tools/call"
          ? {
              content: [{ type: "text", text: "ok" }],
              structuredContent: { value: message.params?.arguments?.value ?? "" },
            }
          : undefined

  if (result === undefined) {
    process.stderr.write("unexpected MCP method\n")
    return
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n")
})
