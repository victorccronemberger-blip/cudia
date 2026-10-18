const worker = new Worker(new URL("./warnings-worker.ts", import.meta.url))
const file = process.argv[2]

worker.addEventListener(
  "message",
  (event: MessageEvent<{ type: string; warning?: unknown; warnings?: Array<Record<string, unknown>> }>) => {
    if (event.data.type === "ready") {
      worker.postMessage({ type: "start" })
      return
    }
    if (event.data.type === "started") {
      worker.postMessage({ type: "subscribe" })
      return
    }
    if (event.data.type === "subscribed") {
      worker.postMessage({
        type: "emit",
        warnings: [
          {
            name: "McpAuditWarning",
            message: "bad logfile still preserves the warning",
            code: "MCP_AUDIT",
            metadata: { server: "isolated-worker", retry: 2 },
          },
        ],
      })
      return
    }
    if (event.data.type === "diagnostic") {
      process.stdout.write(JSON.stringify(event.data.warning) + "\n")
      worker.postMessage({ type: "pending" })
      return
    }
    if (event.data.type === "pending") {
      process.stdout.write(JSON.stringify(event.data.warnings) + "\n")
      worker.postMessage({ type: "stop" })
      return
    }
    if (event.data.type === "stopped") worker.terminate()
  },
)

worker.postMessage({ type: "init", file })
