import { createRequire } from "node:module"

const [mode, scenario] = process.argv.slice(2)
if (mode === "child") {
  if (scenario === "exit") setTimeout(() => process.exit(0), 150)
  if (["stalled", "destroyed-then-close"].includes(scenario)) setInterval(() => {}, 1000)
  if (scenario === "ordered" || scenario === "graceful") {
    setTimeout(() => {
      let buffer = ""
      process.stdin.on("data", (data) => {
        buffer += data
        for (let index; (index = buffer.indexOf("\n")) >= 0; ) {
          const message = JSON.parse(buffer.slice(0, index))
          buffer = buffer.slice(index + 1)
          process.stdout.write(
            JSON.stringify({ jsonrpc: "2.0", method: "ack", params: { index: message.params.index } }) + "\n",
          )
        }
      })
    }, 150)
  }
} else {
  const sdk =
    mode === "cjs"
      ? createRequire(import.meta.url)("@modelcontextprotocol/sdk/client/stdio.js")
      : await import("@modelcontextprotocol/sdk/client/stdio.js")
  const warnings = []
  process.on("warning", (warning) => warnings.push(warning.name))
  const unhandled = []
  process.on("unhandledRejection", (error) => unhandled.push(String(error)))
  const transport = new sdk.StdioClientTransport({
    command: process.execPath,
    args: [import.meta.filename, "child", scenario],
    stderr: "pipe",
  })
  const received = []
  const errors = []
  let childStderr = ""
  transport.stderr.on("data", (data) => {
    childStderr += data
  })
  const deadline = (promise, phase, milliseconds = 7000) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`${phase} did not settle: ${JSON.stringify({ received, errors, childStderr })}`)),
          milliseconds,
        ).unref(),
      ),
    ])
  transport.onmessage = (message) => {
    if (message.method === "ack") received.push(message.params.index)
  }
  transport.onerror = (error) => errors.push(error.code ?? error.message)
  const disconnected = async () =>
    transport.send({ jsonrpc: "2.0", method: "disconnected" }).then(
      () => false,
      (error) => error.message === "Not connected",
    )
  const before = await disconnected()
  await transport.start()
  try {
    const sends = Array.from({ length: 32 }, (_, index) =>
      transport.send({
        jsonrpc: "2.0",
        method: "pressure",
        params: { index, data: "x".repeat(262144) },
      }),
    )
    // Attach rejection handlers before a deliberately broken pipe can fail.
    const settled = Promise.allSettled(sends)
    if (scenario === "destroyed-then-close") transport._process.stdin.destroy(new Error("Test pipe failure"))
    const closing = ["stalled", "graceful", "destroyed-then-close"].includes(scenario) ? transport.close() : undefined
    const outcomes = await deadline(settled, "sends")
    if (scenario === "ordered") {
      const until = Date.now() + 7000
      while (received.length < 32 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await (closing ?? transport.close())
    // Node/Bun warning delivery can happen after a send settles.
    await new Promise((resolve) => setTimeout(resolve, 10))
    console.log(
      JSON.stringify({
        mode,
        scenario,
        before,
        after: await disconnected(),
        received,
        warnings,
        errors,
        unhandled,
        fulfilled: outcomes.filter((result) => result.status === "fulfilled").length,
        rejected: outcomes.filter((result) => result.status === "rejected").length,
      }),
    )
  } finally {
    await transport.close()
  }
}
