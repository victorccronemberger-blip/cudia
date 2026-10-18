import { expect, test } from "bun:test"
import { createWorkerDiagnostics } from "../../opencode/src/cli/tui/diagnostics"
import type { WarningDiagnostic } from "../src/util/warnings"

const warning = (message: string): WarningDiagnostic => ({
  name: "Audit warning",
  message,
  stack: "audit stack",
  details: "audit metadata",
  time: "2026-10-18T00:00:00.000Z",
  file: "audit.log",
  saved: true,
})

test("a rejected diagnostics handshake surfaces an error and preserves buffered events", async () => {
  const listeners = new Set<(event: WarningDiagnostic) => void>()
  const source = createWorkerDiagnostics({
    on: (_event, listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    call: async () => {
      throw new Error("Owned worker stopped")
    },
  })
  for (const listener of listeners) listener(warning("before failure"))
  const received: WarningDiagnostic[] = []
  const off = source.subscribe((event) => received.push(event))
  await source.initialized
  expect(received.map((event) => event.name)).toEqual(["Audit warning", "Worker diagnostics unavailable"])
  expect(source.pending()[0].stack).toContain("Owned worker stopped")
  off()
  source.dispose()
  expect(listeners.size).toBe(0)
})

test("a failed subscriber cannot discard a batch or prevent other subscribers", async () => {
  const source = createWorkerDiagnostics({
    on: () => () => {},
    call: async () => [warning("first"), warning("second")],
  })
  const warnings: Error[] = []
  const capture = (warning: Error) => warnings.push(warning)
  process.on("warning", capture)
  try {
    await source.initialized
    const bad = source.subscribe(() => {
      throw new Error("Owned toast failure")
    })
    expect(source.pending()).toHaveLength(2)
    const received: string[] = []
    const good = source.subscribe((event) => received.push(event.message))
    expect(received).toEqual(["first", "second"])
    expect(source.pending()).toHaveLength(0)
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(warnings.some((warning) => warning.message === "Could not deliver worker diagnostic")).toBe(true)
    bad()
    good()
  } finally {
    process.off("warning", capture)
    source.dispose()
  }
})

test("disposing a bridge makes a late handshake inert", async () => {
  let complete!: (events: WarningDiagnostic[]) => void
  const response = new Promise<WarningDiagnostic[]>((resolve) => {
    complete = resolve
  })
  let removed = 0
  const source = createWorkerDiagnostics({
    on: () => () => {
      removed++
    },
    call: () => response,
  })
  source.dispose()
  complete([warning("late")])
  await source.initialized
  const received: WarningDiagnostic[] = []
  source.subscribe((event) => received.push(event))()
  expect(source.pending()).toEqual([])
  expect(received).toEqual([])
  expect(removed).toBe(1)
})
