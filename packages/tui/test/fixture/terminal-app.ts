import { Effect } from "effect"
import { appendFileSync } from "node:fs"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { run } from "../../src/app"
import { createTuiResolvedConfig } from "./tui-runtime"
import { createEventSource, createFetch, directory, json } from "./tui-sdk"
import { createWorkerDiagnostics } from "../../../opencode/src/cli/tui/diagnostics"
import { Rpc } from "../../../opencode/src/util/rpc"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

const worker = new Worker(new URL("./warning-terminal-worker.ts", import.meta.url).href)
const trace = (phase: string) => {
  const file = process.env.CUDIA_TERMINAL_TRACE
  if (file) appendFileSync(file, `${Date.now()} ${phase}\n`)
}
trace("app:entry")
const client = Rpc.client<{
  diagnostics: () => import("../../src/util/warnings").WarningDiagnostic[]
  inject: () => boolean
  shutdown: () => void
}>(worker)
trace("app:worker-created")
const diagnostics = createWorkerDiagnostics(client)
trace("app:diagnostics-bridge-created")
diagnostics.initialized.then(
  () => trace("app:diagnostics-initialized"),
  (error) => trace(`app:diagnostics-initialization-failed ${String(error)}`),
)
const events = createEventSource()
const calls = createFetch()
const report = { disposes: 0, injected: false, mainInjected: false, exitRequested: false }
let api: TuiPluginApi | undefined
const control = setInterval(async () => {
  const file = Bun.file(process.env.CUDIA_TERMINAL_CONTROL!)
  if (!(await file.exists()) || !api) return
  const action = await file.json()
  if (action.inject && !report.injected) {
    report.injected = true
    await client.call("inject", undefined)
  }
  if (action.injectMain && !report.mainInjected) {
    report.mainInjected = true
    process.emitWarning("CUDIA main thread diagnostic check", { code: "CUDIA_MAIN_TUI_CHECK" })
  }
  if (action.exit && !report.exitRequested) {
    report.exitRequested = true
    api.keymap.dispatchCommand("app.exit")
  }
}, 100)
try {
  await Effect.runPromise(
    run({
      url: "http://fixture.invalid",
      directory,
      config: createTuiResolvedConfig({ mouse: false, plugin_enabled: {} }),
      fetch: calls.fetch,
      events: events.source,
      diagnostics,
      args: {},
      pluginHost: {
        async start(input) {
          trace("app:plugin-host-start")
          api = input.api
          await diagnostics.initialized
          trace("app:diagnostics-ready")
          await Bun.write(process.env.CUDIA_TERMINAL_READY!, "ready")
          trace("app:ready-file-written")
        },
        async dispose() {
          report.disposes++
        },
      },
    }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
  )
} finally {
  trace("app:finally")
  clearInterval(control)
  await client.call("shutdown", undefined)
  diagnostics.dispose()
  worker.terminate()
  await Bun.write(process.env.CUDIA_TERMINAL_REPORT!, JSON.stringify(report))
}
