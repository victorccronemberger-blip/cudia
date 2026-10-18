import { appendFileSync } from "node:fs"
import { inspect } from "node:util"

export type WarningDiagnostic = {
  name: string
  message: string
  stack: string
  code?: string
  details: string
  time: string
  file: string
  saved: boolean
  level?: "warning" | "error"
}

export function createWarningDiagnostics(input: { file: string; notify: (warning: WarningDiagnostic) => void }) {
  const notifications: WarningDiagnostic[] = []
  const unsaved: WarningDiagnostic[] = []
  let active = false
  let subscribed = false

  const record = (warning: unknown, options: { name?: string; code?: string; level?: "warning" | "error" } = {}) => {
    flush()
    let details = "Warning details could not be inspected"
    try {
      details = inspect(warning, {
        customInspect: false,
        getters: false,
        maxArrayLength: null,
        maxStringLength: null,
        depth: null,
      })
    } catch {}
    const code = options.code ?? stringField(warning, "code", "")
    const diagnostic: WarningDiagnostic = {
      name: options.name ?? stringField(warning, "name", "Warning"),
      message: stringField(warning, "message", typeof warning === "string" ? warning : details),
      stack: stringField(warning, "stack", details),
      ...(code ? { code } : {}),
      details,
      time: new Date().toISOString(),
      file: input.file,
      saved: false,
      level: options.level ?? "warning",
    }

    if (unsaved.length > 0 || !save(diagnostic)) unsaved.push(diagnostic)
    deliver(diagnostic)
  }
  const handler = (warning: Error) => record(warning)

  function save(diagnostic: WarningDiagnostic) {
    try {
      appendFileSync(input.file, JSON.stringify({ ...diagnostic, saved: true }) + "\n", "utf8")
      diagnostic.saved = true
      return true
    } catch {
      return false
    }
  }

  function flush() {
    while (unsaved.length > 0) {
      if (!save(unsaved[0])) return
      unsaved.shift()
    }
  }

  function deliver(diagnostic: WarningDiagnostic) {
    if (!subscribed) {
      notifications.push(diagnostic)
      return
    }
    try {
      input.notify(diagnostic)
    } catch {
      notifications.push(diagnostic)
    }
  }

  return {
    record,
    start() {
      if (active) return
      active = true
      process.on("warning", handler)
    },
    stop() {
      if (active) {
        active = false
        process.off("warning", handler)
      }
      flush()
    },
    subscribe() {
      subscribed = true
      return notifications.splice(0)
    },
    pending() {
      return unsaved.map((warning) => ({ ...warning }))
    },
  }
}

function stringField(input: unknown, field: string, fallback: string) {
  try {
    if (typeof input !== "object" || input === null) return fallback
    const value = Reflect.get(input, field)
    if (typeof value === "string") return value
  } catch {}
  return fallback
}
