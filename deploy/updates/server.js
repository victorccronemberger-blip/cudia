import { createUpdateServer } from "./app.js"

// Hostinger imports its entry file from a runner; argv[1] is not this module.
// Keep the reusable factory in app.js and always start the configured entry.
const value = process.env.PORT ?? "3000"
const port = /^[0-9]+$/.test(value) ? Number(value) : undefined
const host = process.env.HOST ?? "0.0.0.0"
if (!Number.isSafeInteger(port) || port < 1 || port > 65535 || !host) {
  process.stderr.write("Invalid server configuration\n")
  process.exitCode = 1
} else {
  const server = createUpdateServer()
  server.listen(port, host, () => {
    process.stdout.write(`cudia-updates listening on ${host}:${port}\n`)
  })
  const shutdown = () => server.close(() => { process.exitCode = 0 })
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
}
