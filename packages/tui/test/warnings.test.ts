import { expect, test } from "bun:test"
import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { tmpdir } from "./fixture/fixture"

type WorkerMessage = {
  type: string
  before?: number
  after?: number
  count?: number
  warnings?: Array<Record<string, unknown>>
  warning?: Record<string, unknown>
}

test("routes consecutive worker warnings through the queue and saves them before stop", async () => {
  const temp = await tmpdir()
  const file = path.join(temp.path, "warnings.jsonl")
  const session = workerSession()

  try {
    await session.send({ type: "init", file }, "ready")
    const started = await session.send({ type: "start" }, "started")
    expect(started.after).toBe(started.before! + 1)

    await session.send({ type: "emit", warnings: [warning(1), warning(2)] }, "emitted")
    const queued = await session.send({ type: "subscribe" }, "subscribed")

    expect(queued.warnings).toHaveLength(2)
    expect(queued.warnings?.[0]).toMatchObject({
      name: "McpAuditWarning",
      message: "MCP warning 1",
      stack: expect.stringContaining("distinctiveMcpHandshake"),
      code: "MCP_AUDIT_1",
      details: expect.stringContaining("metadata: { server: 'audit-server', attempt: 1 }"),
      file,
      saved: true,
    })
    expect(queued.warnings?.[1]?.message).toBe("MCP warning 2")
    expect((await Bun.file(file).text()).trim().split("\n")).toHaveLength(2)

    const live = session.waitFor("diagnostic")
    await session.send({ type: "emit", warnings: [warning(3)] }, "emitted")
    expect((await live).warning).toMatchObject({ message: "MCP warning 3", saved: true })

    const stopped = await session.send({ type: "stop" }, "stopped")
    expect(stopped.after).toBe(stopped.before! - 1)
    expect(JSON.parse((await Bun.file(file).text()).trim().split("\n")[2]).message).toBe("MCP warning 3")
  } finally {
    session.worker.terminate()
    await temp[Symbol.asyncDispose]()
  }
})

test("keeps failed log writes in memory and reports saved false without raw warning output", async () => {
  const temp = await tmpdir()
  const file = path.join(temp.path, "missing", "warnings.jsonl")
  const processFixture = fileURLToPath(new URL("./fixture/warnings-process.ts", import.meta.url))
  const child = Bun.spawn([process.execPath, processFixture, file], { stdout: "pipe", stderr: "pipe" })

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    const [diagnostic, pending] = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))

    expect(exitCode).toBe(0)
    expect(diagnostic).toMatchObject({
      message: "bad logfile still preserves the warning",
      code: "MCP_AUDIT",
      saved: false,
    })
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ saved: false, file })
    expect(stderr).toBe("")
  } finally {
    await temp[Symbol.asyncDispose]()
  }
})

test("notify failures remain queued for the next subscription", async () => {
  const temp = await tmpdir()
  const file = path.join(temp.path, "warnings.jsonl")
  const session = workerSession()

  try {
    await session.send({ type: "init", file, failNotify: true }, "ready")
    await session.send({ type: "start" }, "started")
    await session.send({ type: "subscribe" }, "subscribed")
    await session.send({ type: "emit", warnings: [warning(4)] }, "emitted")
    const retry = await session.send({ type: "subscribe" }, "subscribed")
    expect(retry.warnings).toMatchObject([{ message: "MCP warning 4", saved: true }])
  } finally {
    session.worker.terminate()
    await temp[Symbol.asyncDispose]()
  }
})

test("retries unsaved warnings before appending newer warnings", async () => {
  const temp = await tmpdir()
  const directory = path.join(temp.path, "late")
  const file = path.join(directory, "warnings.jsonl")
  const session = workerSession()

  try {
    await session.send({ type: "init", file }, "ready")
    await session.send({ type: "start" }, "started")
    await session.send({ type: "subscribe" }, "subscribed")

    const first = session.waitFor("diagnostic")
    await session.send({ type: "emit", warnings: [warning(5)] }, "emitted")
    expect((await first).warning).toMatchObject({ message: "MCP warning 5", saved: false })
    expect((await session.send({ type: "pending" }, "pending")).warnings).toHaveLength(1)

    mkdirSync(directory)
    const second = session.waitFor("diagnostic")
    await session.send({ type: "emit", warnings: [warning(6)] }, "emitted")
    expect((await second).warning).toMatchObject({ message: "MCP warning 6", saved: true })
    expect((await session.send({ type: "pending" }, "pending")).warnings).toHaveLength(0)
    expect(
      (await Bun.file(file).text())
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).message),
    ).toEqual(["MCP warning 5", "MCP warning 6"])
  } finally {
    session.worker.terminate()
    await temp[Symbol.asyncDispose]()
  }
})

function workerSession() {
  const worker = new Worker(new URL("./fixture/warnings-worker.ts", import.meta.url))
  const messages: WorkerMessage[] = []
  const waiters: Array<{ type: string; resolve: (message: WorkerMessage) => void }> = []
  worker.addEventListener("message", (event: MessageEvent<WorkerMessage>) => {
    const index = waiters.findIndex((waiter) => waiter.type === event.data.type)
    if (index === -1) {
      messages.push(event.data)
      return
    }
    waiters.splice(index, 1)[0].resolve(event.data)
  })

  return {
    worker,
    send(message: Record<string, unknown>, response: string) {
      const result = this.waitFor(response)
      worker.postMessage(message)
      return result
    },
    waitFor(type: string) {
      const index = messages.findIndex((message) => message.type === type)
      if (index !== -1) return Promise.resolve(messages.splice(index, 1)[0])
      return new Promise<WorkerMessage>((resolve) => waiters.push({ type, resolve }))
    },
  }
}

function warning(index: number) {
  return {
    name: "McpAuditWarning",
    message: `MCP warning ${index}`,
    code: `MCP_AUDIT_${index}`,
    metadata: { server: "audit-server", attempt: index },
  }
}
