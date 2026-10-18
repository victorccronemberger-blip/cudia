import { Rpc } from "../../../opencode/src/util/rpc"
import type { rpc } from "./rpc-worker"

const worker = new Worker(new URL("./rpc-worker.ts", import.meta.url), {
  env: { ...process.env, CUDIA_RPC_CASE: "bootstrap" },
})
const client = Rpc.client<typeof rpc>(worker)
try {
  const calls = await Promise.allSettled([client.call("echo", "first"), client.call("echo", "second")])
  const error = await client.closed
  const later = await client.call("echo", "later").catch((error: Error) => error.message)
  console.log(
    JSON.stringify({ statuses: calls.map((call) => call.status), message: error?.message, cause: error?.cause, later }),
  )
} finally {
  client.dispose()
  worker.terminate()
}
