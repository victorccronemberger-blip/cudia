const readline = require("node:readline")

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

  const result =
    message.method === "initialize"
      ? {
          protocolVersion: "2025-03-26",
          capabilities: { resources: { listChanged: true } },
          serverInfo: { name: "resource-stdio", version: "1.0.0" },
        }
      : message.method === "resources/list"
        ? { resources: [{ uri: "fixture:stdio", name: "stdio-resource" }] }
        : message.method === "resources/templates/list"
          ? { resourceTemplates: [{ uriTemplate: "fixture:{name}", name: "stdio-template" }] }
          : message.method === "resources/read"
            ? { contents: [{ uri: message.params?.uri ?? "", text: "stdio resource" }] }
            : undefined

  if (result === undefined) {
    process.stderr.write("unexpected MCP method\n")
    return
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n")
})
