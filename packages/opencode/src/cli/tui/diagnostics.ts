import type { WarningDiagnostic } from "@opencode-ai/tui/util/warnings"
import { appendFileSync } from "node:fs"
import { inspect } from "node:util"

export function createWorkerDiagnostics(
  client: {
    on: (event: string, handler: (data: WarningDiagnostic) => void) => () => void
    call: (method: "diagnostics", input: undefined) => Promise<WarningDiagnostic[]>
  },
  file = "",
) {
  const pending: WarningDiagnostic[] = []
  const failures: WarningDiagnostic[] = []
  const listeners = new Set<(warning: WarningDiagnostic) => void>()
  let ready = false
  let disposed = false
  let failed = false
  const flush = () => {
    if (disposed || !ready || listeners.size === 0) return
    const retry: WarningDiagnostic[] = []
    for (const warning of pending.splice(0)) {
      let delivered = false
      for (const listener of listeners) {
        try {
          listener(warning)
          delivered = true
        } catch (error) {
          process.emitWarning(new Error("Could not deliver worker diagnostic", { cause: error }))
        }
      }
      if (!delivered) retry.push(warning)
    }
    pending.unshift(...retry)
  }
  const off = client.on("diagnostic", (warning) => {
    if (disposed) return
    pending.push(warning)
    flush()
  })
  const report = (error: unknown, initialization = false) => {
    if (disposed || failed) return
    if (!initialization) failed = true
    let details = "Worker failure details unavailable"
    try {
      details = inspect(error, { depth: null, customInspect: false, getters: false })
    } catch {}
    const diagnostic: WarningDiagnostic = {
      name: initialization ? "Worker diagnostics unavailable" : "Worker unavailable",
      message: initialization
        ? "Could not initialize worker diagnostics."
        : "CUDIA worker stopped. Restart CUDIA to reconnect.",
      stack: details,
      details,
      time: new Date().toISOString(),
      file,
      saved: false,
      level: "error",
    }
    if (file) {
      try {
        appendFileSync(file, JSON.stringify({ ...diagnostic, saved: true }) + "\n", "utf8")
        diagnostic.saved = true
      } catch {}
    }
    if (!diagnostic.saved) failures.push(diagnostic)
    pending.push(diagnostic)
    ready = true
    flush()
  }
  const initialized = Promise.resolve()
    .then(() => (disposed ? [] : client.call("diagnostics", undefined)))
    .then((warnings) => {
      if (disposed) return
      pending.unshift(...warnings)
      ready = true
      flush()
    })
    .catch((error: unknown) => {
      report(error, true)
    })
  return {
    initialized,
    report,
    subscribe(listener: (warning: WarningDiagnostic) => void) {
      if (disposed) return () => {}
      listeners.add(listener)
      flush()
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      off()
      listeners.clear()
      pending.length = 0
      failures.length = 0
    },
    pending() {
      return [...new Set([...pending, ...failures])].map((warning) => ({ ...warning }))
    },
  }
}
