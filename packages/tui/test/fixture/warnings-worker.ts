import { createWarningDiagnostics } from "../../src/util/warnings"
import type { WarningDiagnostic } from "../../src/util/warnings"

type Request =
  | { type: "init"; file: string; failNotify?: boolean }
  | { type: "start" }
  | { type: "emit"; warnings: Array<{ name: string; message: string; code: string; metadata: unknown }> }
  | { type: "subscribe" }
  | { type: "pending" }
  | { type: "stop" }
  | { type: "counts" }

type Response =
  | { type: "ready" }
  | { type: "started"; before: number; after: number }
  | { type: "emitted" }
  | { type: "diagnostic"; warning: WarningDiagnostic }
  | { type: "subscribed"; warnings: WarningDiagnostic[] }
  | { type: "pending"; warnings: WarningDiagnostic[] }
  | { type: "stopped"; before: number; after: number }
  | { type: "counts"; count: number }

let diagnostics: ReturnType<typeof createWarningDiagnostics> | undefined
let failNotify = false

self.onmessage = (event: MessageEvent<Request>) => {
  const request = event.data
  if (request.type === "init") {
    failNotify = request.failNotify ?? false
    diagnostics = createWarningDiagnostics({
      file: request.file,
      notify: (warning) => {
        if (failNotify) {
          failNotify = false
          throw new Error("notification is temporarily unavailable")
        }
        postMessage({ type: "diagnostic", warning } satisfies Response)
      },
    })
    postMessage({ type: "ready" } satisfies Response)
    return
  }

  if (!diagnostics) throw new Error("Warning diagnostics are not initialized")

  if (request.type === "start") {
    const before = process.listenerCount("warning")
    diagnostics.start()
    diagnostics.start()
    postMessage({ type: "started", before, after: process.listenerCount("warning") } satisfies Response)
    return
  }

  if (request.type === "emit") {
    for (const input of request.warnings) {
      const warning = new Error(input.message) as Error & { code: string; metadata: unknown }
      warning.name = input.name
      warning.code = input.code
      warning.metadata = input.metadata
      warning.stack = `${input.name}: ${input.message}\n    at distinctiveMcpHandshake (warnings-worker.ts:43:7)`
      process.emitWarning(warning)
    }
    setTimeout(() => postMessage({ type: "emitted" } satisfies Response), 25)
    return
  }

  if (request.type === "subscribe") {
    postMessage({ type: "subscribed", warnings: diagnostics.subscribe() } satisfies Response)
    return
  }

  if (request.type === "pending") {
    postMessage({ type: "pending", warnings: diagnostics.pending() } satisfies Response)
    return
  }

  if (request.type === "stop") {
    const before = process.listenerCount("warning")
    diagnostics.stop()
    postMessage({ type: "stopped", before, after: process.listenerCount("warning") } satisfies Response)
    return
  }

  postMessage({ type: "counts", count: process.listenerCount("warning") } satisfies Response)
}
