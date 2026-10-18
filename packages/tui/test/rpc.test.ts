import { expect, test } from "bun:test"
import { Rpc } from "../../opencode/src/util/rpc"
import { fileURLToPath } from "node:url"
import type { rpc } from "./fixture/rpc-worker"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

function connection(mode = "healthy", log?: string) {
  const worker = new Worker(new URL("./fixture/rpc-worker.ts", import.meta.url), {
    env: { ...process.env, CUDIA_RPC_CASE: mode, ...(log ? { CUDIA_RPC_WARNING_LOG: log } : {}) },
  })
  const client = Rpc.client<typeof rpc>(worker)
  return {
    worker,
    client,
    dispose() {
      client.dispose()
      worker.terminate()
    },
  }
}

test("background rejections are recorded as errors while healthy RPC remains available", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cudia-rpc-background-"))
  const log = path.join(directory, "worker.log")
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL("./fixture/rpc-background-process.ts", import.meta.url)), log],
    { stdout: "pipe", stderr: "pipe" },
  )
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit).toBe(0)
    expect(stderr).toBe("")
    const result = JSON.parse(stdout)
    expect(result.records[0]).toMatchObject({ level: "error", code: "CUDIA_UNHANDLED_REJECTION", saved: true })
    expect(result.healthy).toBe("other models can continue")
    expect(result.methodError).toBe("Owned asynchronous RPC failure")
    expect(result.afterMethod).toBe(1)
    expect(result.records[1]).toMatchObject({ level: "error", message: "null", saved: true })
    expect(await readFile(log, "utf8")).toContain("Owned background rejection")
  } finally {
    child.kill()
    await child.exited
    await rm(directory, { recursive: true, force: true })
  }
})

test("a fatal worker exception rejects calls and releases its representative MCP subprocess", async () => {
  const owned = connection()
  let pid: number | undefined
  const alive = () => {
    if (pid === undefined) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  try {
    const value = await owned.client.call("child", undefined)
    expect(typeof value).toBe("number")
    if (value === null) throw new Error("Owned MCP fixture did not start")
    pid = value
    expect(alive()).toBe(true)
    const calls = Promise.allSettled([owned.client.call("hold", undefined)])
    await owned.client.call("uncaught", undefined)
    expect((await calls)[0].status).toBe("rejected")
    const error = await owned.client.closed
    expect(error?.cause).toContain("Owned fatal worker exception")
    const deadline = Date.now() + 2000
    while (alive() && Date.now() < deadline) await Bun.sleep(25)
    expect(alive()).toBe(false)
  } finally {
    owned.dispose()
    if (alive() && pid !== undefined) process.kill(pid, "SIGTERM")
  }
}, 10_000)

test("RPC preserves values and undefined results across a real worker", async () => {
  const owned = connection()
  try {
    expect(await owned.client.call("echo", { exact: "model/tool data", number: 42 })).toEqual({
      exact: "model/tool data",
      number: 42,
    })
    expect(await owned.client.call("empty", undefined)).toBeUndefined()
  } finally {
    owned.dispose()
  }
})

test("sync, async, non-Error and serialization failures reject only their request", async () => {
  const owned = connection()
  try {
    await expect(owned.client.call("fail", undefined)).rejects.toThrow("Owned synchronous RPC failure")
    await expect(owned.client.call("reject", undefined)).rejects.toThrow("Owned asynchronous RPC failure")
    await expect(owned.client.call("odd", "string")).rejects.toThrow("Owned string failure")
    await expect(owned.client.call("odd", "null")).rejects.toThrow("Worker request failed")
    await expect(owned.client.call("odd", "getter")).rejects.toThrow("Worker request failed")
    await expect(owned.client.call("circular", undefined)).rejects.toBeInstanceOf(Error)
    expect(await owned.client.call("echo", "still available")).toBe("still available")
  } finally {
    owned.dispose()
  }
})

test("worker exit rejects every pending call and future calls", async () => {
  const owned = connection()
  try {
    const settled = Promise.allSettled([owned.client.call("hold", undefined), owned.client.call("hold", undefined)])
    await owned.client.call("exit", undefined)
    const calls = await settled
    expect(calls.map((call) => call.status)).toEqual(["rejected", "rejected"])
    const reason = await owned.client.closed
    expect(reason?.message).toBe("CUDIA worker stopped unexpectedly")
    await expect(owned.client.call("echo", "later")).rejects.toBe(reason)
  } finally {
    owned.dispose()
  }
})

test("a malformed response fails the channel instead of leaving calls pending", async () => {
  const owned = connection("malformed")
  try {
    await expect(owned.client.call("echo", "request")).rejects.toThrow("CUDIA worker sent an invalid response")
    expect((await owned.client.closed)?.message).toBe("CUDIA worker sent an invalid response")
  } finally {
    owned.dispose()
  }
})

test("serialization failure removes only its pending request and keeps the channel usable", async () => {
  const owned = connection()
  try {
    const input: { self?: unknown } = {}
    input.self = input
    await expect(owned.client.call("echo", input)).rejects.toThrow("Could not send worker request")
    expect(await owned.client.call("echo", "healthy after encoding error")).toBe("healthy after encoding error")
  } finally {
    owned.dispose()
  }
})

test("bad event subscribers are isolated and unsubscribing removes their delivery", async () => {
  const owned = connection()
  const received: string[] = []
  const warnings: Error[] = []
  const capture = (warning: Error) => warnings.push(warning)
  process.on("warning", capture)
  try {
    const bad = owned.client.on("audit", () => {
      throw new Error("Owned listener failure")
    })
    const good = owned.client.on<string>("audit", (value) => received.push(value))
    await owned.client.call("events", undefined)
    expect(received).toEqual(["event"])
    expect(warnings[0]?.message).toBe("Worker event listener failed")
    bad()
    good()
    await owned.client.call("events", undefined)
    expect(received).toEqual(["event"])
  } finally {
    process.off("warning", capture)
    owned.dispose()
  }
})

test("intentional disposal rejects pending calls without reporting unexpected failure", async () => {
  const owned = connection()
  try {
    const settled = Promise.allSettled([owned.client.call("hold", undefined)])
    owned.client.dispose()
    owned.client.dispose()
    expect((await settled)[0].status).toBe("rejected")
    expect(await owned.client.closed).toBeUndefined()
    await expect(owned.client.call("echo", "later")).rejects.toThrow("RPC client disposed")
  } finally {
    owned.dispose()
  }
})

test("bootstrap worker failure reaches callers without dumping raw stderr", async () => {
  const child = Bun.spawn(
    [process.execPath, fileURLToPath(new URL("./fixture/rpc-failure-process.ts", import.meta.url))],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exit).toBe(0)
    expect(stderr).toBe("")
    const result = JSON.parse(stdout)
    expect(result.statuses).toEqual(["rejected", "rejected"])
    expect(result.message).toBe("CUDIA worker failed")
    expect(result.cause).toContain("Owned RPC worker bootstrap failure")
    expect(result.later).toBe(result.message)
  } finally {
    child.kill()
    await child.exited
  }
})
