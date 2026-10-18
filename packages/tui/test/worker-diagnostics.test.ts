import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Rpc } from "../../opencode/src/util/rpc"
import { createWorkerDiagnostics } from "../../opencode/src/cli/tui/diagnostics"
import type { WarningDiagnostic } from "../src/util/warnings"

test("worker diagnostics survive startup and UI subscription changes in order", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cudia-worker-diagnostics-"))
  const file = path.join(directory, "warnings.log")
  const worker = new Worker(new URL("./fixture/warning-terminal-worker.ts", import.meta.url).href, {
    env: { ...process.env, CUDIA_TERMINAL_WARNING_LOG: file },
  })
  const client = Rpc.client<{
    diagnostics: () => WarningDiagnostic[]
    inject: (message?: string) => boolean
    shutdown: () => void
  }>(worker)
  try {
    await client.call("inject", "before bridge")
    const source = createWorkerDiagnostics(client)
    await source.initialized
    await client.call("inject", "before UI")
    const received: WarningDiagnostic[] = []
    const off = source.subscribe((warning) => received.push(warning))
    await client.call("inject", "live")
    expect(received.map((warning) => warning.message)).toEqual(["before bridge", "before UI", "live"])
    expect(received.every((warning) => warning.saved && warning.file === file)).toBe(true)
    off()
    await client.call("inject", "UI temporarily detached")
    const later: WarningDiagnostic[] = []
    const stop = source.subscribe((warning) => later.push(warning))
    expect(later.map((warning) => warning.message)).toEqual(["UI temporarily detached"])
    stop()
    source.dispose()
    await client.call("shutdown", undefined)
    const log = await readFile(file, "utf8")
    for (const message of ["before bridge", "before UI", "live", "UI temporarily detached"])
      expect(log).toContain(message)
  } finally {
    worker.terminate()
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)
