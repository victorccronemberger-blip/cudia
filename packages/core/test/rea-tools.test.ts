import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { createHash } from "node:crypto"
import { isReaCommand } from "../src/mcp/rea-command"
import { environmentFor, inspect, install, type Tool } from "../src/mcp/rea-tools"
import { tmpdir } from "./fixture/tmpdir"

async function fixture(root: string, archive = false) {
  const payload = path.join(root, "payload")
  await fs.mkdir(path.join(payload, "bin"), { recursive: true })
  await fs.writeFile(path.join(payload, "bin", "fixture.exe"), "owned fixture bytes")
  const packed = path.join(root, "fixture.tar.gz")
  if (archive) {
    const result = Bun.spawn(
      [path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), "-czf", packed, "-C", payload, "bin"],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(await result.exited).toBe(0)
  }
  const bytes = archive ? await fs.readFile(packed) : Buffer.from("owned fixture bytes")
  let requests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++
      return new Response(bytes)
    },
  })
  const tool: Tool = {
    name: "fixture",
    version: "1",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url: `http://127.0.0.1:${server.port}/tool`,
    size: bytes.length,
    format: archive ? "archive" : "file",
    required: ["bin/fixture.exe"],
    environment: { REA_WABT_BIN_DIRECTORY: "bin" },
  }
  return {
    tool,
    requests: () => requests,
    [Symbol.dispose]() {
      server.stop(true)
    },
  }
}

test("recognizes managed and standard REA registrations without matching unrelated servers", () => {
  expect(isReaCommand("node", ["C:\\cache\\node_modules\\rea-agents\\scripts\\rea.mjs", "mcp"])).toBe(true)
  expect(isReaCommand("C:\\bin\\rea.cmd", ["mcp"])).toBe(true)
  expect(isReaCommand("npx", ["--yes", "rea-agents@6.5.0", "mcp"])).toBe(true)
  expect(isReaCommand("node", ["C:/project/unrelated-rea.mjs"])).toBe(false)
  expect(isReaCommand("node", ["C:/project/rea-agents/scripts/not-rea.mjs"])).toBe(false)
  expect(isReaCommand("unrelated.exe", ["rea-agents"])).toBe(false)
  expect(isReaCommand("node", ["ordinary.js", "C:/cache/rea-agents/scripts/rea.mjs"])).toBe(false)
  expect(isReaCommand("npx", ["--yes", "unrelated", "rea-agents"])).toBe(false)
})

test("missing optional tools and unrelated MCP servers need no configuration or network", async () => {
  await using tmp = await tmpdir()
  const env = { KEEP: "value" }
  expect(await environmentFor("unrelated", [], env, tmp.path)).toBe(env)
  expect((await environmentFor("rea", ["mcp"], env, tmp.path)).KEEP).toBe("value")
  expect((await fs.readdir(tmp.path)).length).toBe(0)
})

const windows = process.platform === "win32" && process.arch === "x64" ? test : test.skip
for (const archive of [false, true])
  windows(
    `installs ${archive ? "archive" : "single file"} once across concurrent calls and injects only child environment`,
    async () => {
      await using tmp = await tmpdir()
      using source = await fixture(tmp.path, archive)
      const root = path.join(tmp.path, "cache")
      const results = await Promise.all([install(source.tool, root), install(source.tool, root)])
      expect(results.every((result) => result.state === "ready")).toBe(true)
      expect(source.requests()).toBe(1)
      const configured = { KEEP: "unchanged", JAVA_HOME: "C:\\explicit\\jdk" }
      const env = await environmentFor("node", ["C:/cache/rea-agents/scripts/rea.mjs"], configured, root, [source.tool])
      expect(env).toMatchObject(configured)
      expect(env.REA_WABT_BIN_DIRECTORY).toContain("i-fixture-")
      expect(configured).not.toHaveProperty("REA_WABT_BIN_DIRECTORY")
      expect(
        await environmentFor("rea", [], { REA_WABT_BIN_DIRECTORY: "C:\\explicit-invalid" }, root, [source.tool]),
      ).toEqual({ REA_WABT_BIN_DIRECTORY: "C:\\explicit-invalid" })
    },
  )

windows("bad checksum and aborted downloads never publish a ready installation", async () => {
  await using tmp = await tmpdir()
  using source = await fixture(tmp.path)
  const root = path.join(tmp.path, "cache")
  const bad = { ...source.tool, sha256: "0".repeat(64) }
  await expect(install(bad, root)).rejects.toThrow("checksum")
  expect((await inspect(source.tool, root)).state).toBe("missing")
  const controller = new AbortController()
  controller.abort(new Error("cancel fixture"))
  await expect(install(source.tool, root, controller.signal)).rejects.toThrow("cancel fixture")
  expect((await inspect(source.tool, root)).state).toBe("missing")
  expect((await fs.readdir(root)).some((name) => name.startsWith(".staging"))).toBe(false)
})

windows("cancels a download in progress and leaves the next installation usable", async () => {
  await using tmp = await tmpdir()
  using source = await fixture(tmp.path)
  const entered = Promise.withResolvers<void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]))
            entered.resolve()
          },
        }),
      )
    },
  })
  const root = path.join(tmp.path, "cache")
  const controller = new AbortController()
  const waiting = install({ ...source.tool, url: `http://127.0.0.1:${server.port}/slow` }, root, controller.signal)
  try {
    await entered.promise
    controller.abort(new Error("cancel in progress"))
    await expect(waiting).rejects.toThrow()
    expect((await inspect(source.tool, root)).state).toBe("missing")
    expect((await fs.readdir(root)).some((name) => name.startsWith(".staging"))).toBe(false)
    expect((await install(source.tool, root)).state).toBe("ready")
  } finally {
    server.stop(true)
  }
})

windows("rejects a corrupt archive and an escaping receipt without accepting a partial installation", async () => {
  await using tmp = await tmpdir()
  using source = await fixture(tmp.path)
  const root = path.join(tmp.path, "cache")
  await expect(install({ ...source.tool, format: "archive" }, root)).rejects.toThrow()
  expect((await inspect(source.tool, root)).state).toBe("missing")
  await fs.writeFile(path.join(root, "fixture.json"), JSON.stringify({ directory: "../outside" }))
  expect((await inspect(source.tool, root)).state).toBe("invalid")
  expect((await install(source.tool, root)).state).toBe("ready")
})

windows(
  "cancels after real extraction begins without publishing a partial installation",
  async () => {
    await using tmp = await tmpdir()
    const bytes = 128 * 1024 * 1024
    const payload = path.join(tmp.path, "large.bin")
    const handle = await fs.open(payload, "w")
    await handle.truncate(bytes)
    await handle.close()
    const packed = path.join(tmp.path, "large.tar.gz")
    const compressor = Bun.spawn(
      [
        path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
        "-czf",
        packed,
        "-C",
        tmp.path,
        "large.bin",
      ],
      { stdout: "pipe", stderr: "pipe" },
    )
    expect(await compressor.exited).toBe(0)
    const body = await fs.readFile(packed)
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(body) })
    const tool: Tool = {
      name: "extractor",
      version: "1",
      url: `http://127.0.0.1:${server.port}/archive`,
      size: body.length,
      sha256: createHash("sha256").update(body).digest("hex"),
      format: "archive",
      required: ["large.bin"],
      environment: {},
    }
    const root = path.join(tmp.path, "cache")
    const controller = new AbortController()
    const waiting = install(tool, root, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    )
    let partial = false
    try {
      const limit = performance.now() + 7000
      while (performance.now() < limit) {
        const stage = (await fs.readdir(root).catch(() => [])).find((name) => name.startsWith(".staging-"))
        const info = stage
          ? await fs.stat(path.join(root, stage, "content", "large.bin")).catch(() => undefined)
          : undefined
        if (info && info.size > 0) {
          partial = true
          break
        }
        await Bun.sleep(2)
      }
      if (!partial)
        throw (await waiting) ?? new Error("Extraction completed before the fixture observed its staged file")
      controller.abort(new Error("cancel extractor"))
      expect(await waiting).toBeInstanceOf(Error)
      expect((await inspect(tool, root)).state).toBe("missing")
      expect((await fs.readdir(root)).some((name) => name.startsWith(".staging"))).toBe(false)
    } finally {
      controller.abort()
      await waiting
      server.stop(true)
    }
  },
  15000,
)

windows("corrupt optional installation stays isolated and reinstall repairs it", async () => {
  await using tmp = await tmpdir()
  using source = await fixture(tmp.path)
  const root = path.join(tmp.path, "cache")
  const ready = await install(source.tool, root)
  await fs.writeFile(path.join(ready.environment.REA_WABT_BIN_DIRECTORY!, "fixture.exe"), "corrupted")
  expect((await inspect(source.tool, root)).state).toBe("invalid")
  const warnings: Error[] = []
  const listener = (warning: Error) => warnings.push(warning)
  process.on("warning", listener)
  try {
    expect(await environmentFor("rea", [], { KEEP: "usable" }, root, [source.tool])).toEqual({ KEEP: "usable" })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(warnings[0]?.message).toContain("cudia rea install fixture")
  } finally {
    process.off("warning", listener)
  }
  expect((await install(source.tool, root)).state).toBe("ready")
  expect(source.requests()).toBe(2)
})
