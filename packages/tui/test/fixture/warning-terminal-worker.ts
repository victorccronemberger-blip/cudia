import { createWarningDiagnostics } from "../../src/util/warnings"
import { Rpc } from "../../../opencode/src/util/rpc"
import { appendFileSync } from "node:fs"

const trace = (phase: string) => {
  const file = process.env.CUDIA_TERMINAL_TRACE
  if (file) appendFileSync(file, `${Date.now()} ${phase}\n`)
}
trace("worker:entry")

const warnings = createWarningDiagnostics({
  file: process.env.CUDIA_TERMINAL_WARNING_LOG!,
  notify: (warning) => Rpc.emit("diagnostic", warning),
})
trace("worker:warning-router-created")
warnings.start()
trace("worker:warning-router-started")
Rpc.listen({
  diagnostics() {
    trace("worker:diagnostics-rpc")
    return warnings.subscribe()
  },
  inject(message?: string) {
    trace("worker:inject-rpc")
    process.emitWarning(message ?? "CUDIA terminal diagnostic check", { code: "CUDIA_TUI_CHECK" })
    return true
  },
  shutdown() {
    trace("worker:shutdown-rpc")
    warnings.stop()
  },
})
trace("worker:rpc-listening")
