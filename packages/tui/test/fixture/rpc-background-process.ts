import { Rpc } from "../../../opencode/src/util/rpc"
import type { rpc } from "./rpc-worker"
import type { WarningDiagnostic } from "../../src/util/warnings"

const worker = new Worker(new URL("./rpc-worker.ts", import.meta.url), {
  env: { ...process.env, CUDIA_RPC_CASE: "healthy", CUDIA_RPC_WARNING_LOG: process.argv[2] },
})
const client = Rpc.client<typeof rpc>(worker)
const records: WarningDiagnostic[] = []
const waiters: Array<(warning: WarningDiagnostic) => void> = []
client.on<WarningDiagnostic>("diagnostic", (warning) => {
  records.push(warning)
  waiters.shift()?.(warning)
})
try {
  await client.call("diagnostics", undefined)
  const first = new Promise<WarningDiagnostic>((resolve) => waiters.push(resolve))
  await client.call("background", "error")
  await first
  const healthy = await client.call("echo", "other models can continue")
  const methodError = await client.call("reject", undefined).catch((error: Error) => error.message)
  await Bun.sleep(25)
  const afterMethod = records.length
  const second = new Promise<WarningDiagnostic>((resolve) => waiters.push(resolve))
  await client.call("background", "null")
  await second
  await client.call("shutdown", undefined)
  console.log(JSON.stringify({ records, healthy, methodError, afterMethod }))
} finally {
  client.dispose()
  worker.terminate()
}
