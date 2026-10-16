import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { once } from "node:events"
import { fileURLToPath } from "node:url"

test("starts the configured entry both directly and through a hosting runner import", async () => {
  for (const mode of ["direct", "hosting-import"]) {
    const reservation = createServer()
    reservation.listen(0, "127.0.0.1")
    await once(reservation, "listening")
    const port = reservation.address().port
    await new Promise((resolve) => reservation.close(resolve))
    const entry = new URL("../server.js", import.meta.url)
    const child = spawn(process.execPath, mode === "direct"
      ? [fileURLToPath(entry)]
      : ["--input-type=module", "-e", `await import(${JSON.stringify(entry.href)})`], {
      env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    try {
      const [ready] = await once(child.stdout, "data", { signal: AbortSignal.timeout(10000) })
      assert.match(ready.toString(), /cudia-updates listening/)
      const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(5000) })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), { status: "ok" })
    } finally {
      if (child.exitCode === null) {
        const stopped = once(child, "exit")
        child.kill("SIGTERM")
        await stopped
      }
    }
  }
})
