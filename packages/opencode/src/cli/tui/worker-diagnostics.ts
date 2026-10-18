import { createWarningDiagnostics } from "@opencode-ai/tui/util/warnings"

export function installWorkerDiagnostics(input: Parameters<typeof createWarningDiagnostics>[0]) {
  const diagnostics = createWarningDiagnostics(input)
  const rejection = (error: unknown) =>
    diagnostics.record(error, {
      name: "Background operation failed",
      code: "CUDIA_UNHANDLED_REJECTION",
      level: "error",
    })
  diagnostics.start()
  process.on("unhandledRejection", rejection)
  return {
    subscribe: diagnostics.subscribe,
    pending: diagnostics.pending,
    stop() {
      process.off("unhandledRejection", rejection)
      diagnostics.stop()
    },
  }
}
