import { Rpc } from "../../../opencode/src/util/rpc"
import { installWorkerDiagnostics } from "../../../opencode/src/cli/tui/worker-diagnostics"
import { fileURLToPath } from "node:url"

if (process.env.CUDIA_RPC_CASE === "bootstrap") throw new Error("Owned RPC worker bootstrap failure")
if (process.env.CUDIA_RPC_CASE === "malformed") {
  onmessage = () => postMessage("{broken response")
}
const diagnostics = process.env.CUDIA_RPC_WARNING_LOG
  ? installWorkerDiagnostics({
      file: process.env.CUDIA_RPC_WARNING_LOG,
      notify: (warning) => Rpc.emit("diagnostic", warning),
    })
  : undefined
let child:
  | import("../../../core/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js").StdioClientTransport
  | undefined

export const rpc = {
  echo(input: unknown) {
    return input
  },
  empty() {},
  fail() {
    throw new Error("Owned synchronous RPC failure")
  },
  async reject() {
    throw new Error("Owned asynchronous RPC failure")
  },
  odd(input: string) {
    if (input === "string") throw "Owned string failure"
    if (input === "null") throw null
    throw Object.defineProperty({}, "message", {
      get() {
        throw new Error("Owned throwing getter")
      },
    })
  },
  circular() {
    const result: { self?: unknown } = {}
    result.self = result
    return result
  },
  events() {
    Rpc.emit("audit", "event")
    return true
  },
  hold() {
    return new Promise<void>(() => {})
  },
  exit() {
    setTimeout(() => process.exit(7), 20)
  },
  background(input: string) {
    setTimeout(() => {
      void Promise.reject(input === "null" ? null : new Error("Owned background rejection"))
    }, 10)
  },
  uncaught() {
    setTimeout(() => {
      throw new Error("Owned fatal worker exception")
    }, 10)
  },
  async child() {
    const { StdioClientTransport } = await import(
      "../../../core/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js"
    )
    child = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../../../core/test/mcp-fixtures/stdio.js", import.meta.url))],
      stderr: "pipe",
    })
    child.stderr?.on("data", () => {})
    await child.start()
    return child.pid
  },
  diagnostics() {
    return diagnostics?.subscribe() ?? []
  },
  async shutdown() {
    diagnostics?.stop()
    await child?.close()
  },
}

if (process.env.CUDIA_RPC_CASE !== "malformed") Rpc.listen(rpc)
