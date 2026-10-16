import { describe, expect, it } from "bun:test"
import { Effect, Exit, Fiber, Layer, Scope } from "effect"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ConfigLSP } from "../src/config/lsp"
import { LayerNode } from "../src/effect/layer-node"
import { FSUtil } from "../src/fs-util"
import { LSPV2 } from "../src/lsp"
import { LSPClient } from "../src/lsp/client"
import { LSPFraming } from "../src/lsp/framing"
import { Service, node } from "../src/process"

const fixture = path.join(import.meta.dir, "lsp-fixtures", "stdio.js")
const layer = Layer.merge(LayerNode.compile(FSUtil.node), LayerNode.compile(node))
type Event = {
  type: string
  pid?: number
  cwd?: string
  method?: string
  id?: number
  params?: unknown
  message?: unknown
}

async function setup(mode = "normal") {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "cudia-lsp-test-")))
  const filePath = path.join(directory, "file.ts")
  await writeFile(filePath, "const 😀name = 1\r\ncall()\r\n")
  const events: Event[] = []
  const watchers = new Set<() => void>()
  const holds = new Map<number, () => void>()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const value = (await request.json()) as Event & { id: number }
      if (new URL(request.url).pathname === "/hold") {
        return new Promise<Response>((resolve) => {
          holds.set(value.id, () => {
            holds.delete(value.id)
            resolve(new Response("release"))
          })
          events.push({ type: "held", id: value.id })
          watchers.forEach((notify) => notify())
        })
      }
      events.push(value)
      watchers.forEach((notify) => notify())
      return new Response("ok")
    },
  })
  const wait = (predicate: (value: Event) => boolean) =>
    new Promise<Event>((resolve, reject) => {
      const timer = setTimeout(() => {
        watchers.delete(check)
        reject(new Error("Fixture barrier timed out"))
      }, 4_000)
      const check = () => {
        const found = events.find(predicate)
        if (!found) return
        clearTimeout(timer)
        watchers.delete(check)
        resolve(found)
      }
      watchers.add(check)
      check()
    })
  const configuration = {
    fixture: new ConfigLSP.Server({
      command: [process.execPath, fixture],
      extensions: ["ts"],
      env: { LSP_MODE: mode, LSP_CONTROL: server.url.href.replace(/\/$/, "") },
    }),
  }
  return {
    directory,
    filePath,
    events,
    wait,
    holds,
    configuration,
    async close() {
      holds.forEach((release) => release())
      await server.stop(true)
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function position(filePath: string, operation: LSPV2.Operation = "hover"): LSPV2.Query {
  return { filePath, operation, line: 0, character: 8 }
}
function text(result: LSPV2.Result) {
  return JSON.parse((result.result as { contents: { value: string } }).contents.value) as {
    document: {
      languageId: string
      text: string
      version: number
      changes: { text: string; range?: { end: { line: number; character: number } } }[]
    }
    position: { line: number; character: number }
    pid: number
    events: string[]
  }
}
function run<A, E>(
  input: Awaited<ReturnType<typeof setup>> & { fs?: (fs: FSUtil.Interface) => FSUtil.Interface },
  body: (runtime: LSPV2.Interface) => Effect.Effect<A, E>,
  ...configuration: [] | [typeof ConfigLSP.Info.Type | undefined]
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const process = yield* Service
        const runtime = yield* LSPV2.make({
          directory: input.directory,
          configuration: configuration.length ? configuration[0] : input.configuration,
          fs: input.fs?.(fs) ?? fs,
          process,
          timeout: { startup: 3_000, request: 1_000 },
        })
        return yield* body(runtime)
      }),
    ).pipe(Effect.provide(layer)),
  )
}

describe("native Location LSP", () => {
  it("starts no idle child, uses one connection, synchronizes fresh UTF-8 and UTF-16 CRLF positions", async () => {
    const input = await setup("fragment")
    let pid = 0
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          expect(input.events).toHaveLength(0)
          const first = text(yield* runtime.query(position(input.filePath)))
          pid = first.pid
          expect(first.document.version).toBe(1)
          expect(first.position).toEqual({ line: 0, character: 8 })
          expect(first.document.text).toContain("😀")
          const unchanged = text(yield* runtime.query(position(input.filePath)))
          expect(unchanged.document.version).toBe(1)
          yield* Effect.promise(() => writeFile(input.filePath, "const 😀name = 2\r\ncall(3)\r\n"))
          const fresh = text(yield* runtime.query(position(input.filePath)))
          expect(fresh.document.version).toBe(2)
          expect(fresh.document.text).toContain("call(3)")
          expect(fresh.document.changes[0]?.range?.end).toEqual({ line: 2, character: 0 })
          expect(fresh.events.filter((method) => method === "initialize")).toHaveLength(1)
          expect(fresh.events.filter((method) => method === "textDocument/didOpen")).toHaveLength(1)
        }),
      )
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      await input.close()
    }
  })

  it("supports full text synchronization", async () => {
    const input = await setup("full")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          yield* runtime.query(position(input.filePath))
          yield* Effect.promise(() => writeFile(input.filePath, "new text"))
          const fresh = text(yield* runtime.query({ ...position(input.filePath), character: 1 }))
          expect(fresh.document.version).toBe(2)
          expect(fresh.document.changes).toEqual([{ text: "new text" }])
        }),
      )
    } finally {
      await input.close()
    }
  })

  it("uses standard language IDs for the advertised TypeScript and JavaScript module extensions", async () => {
    const input = await setup()
    try {
      await run(
        input,
        (runtime) =>
          Effect.gen(function* () {
            for (const [extension, expected] of [
              ["mts", "typescript"],
              ["cts", "typescript"],
              ["mjs", "javascript"],
              ["cjs", "javascript"],
            ]) {
              const filePath = path.join(input.directory, `module.${extension}`)
              yield* Effect.promise(() => writeFile(filePath, "const value = 1"))
              const result = text(yield* runtime.query({ ...position(filePath), character: 0 }))
              expect(result.document.languageId).toBe(expected)
            }
          }),
        {
          typescript: new ConfigLSP.Server({
            command: [process.execPath, fixture],
            env: input.configuration.fixture.env,
          }),
        },
      )
    } finally {
      await input.close()
    }
  })

  it("implements all nine queries and retains external metadata without inspecting or reading its targets", async () => {
    const input = await setup()
    const accessed: string[] = []
    try {
      await run(
        {
          ...input,
          fs: (fs) => ({
            ...fs,
            realPath: (target) => Effect.sync(() => accessed.push(target)).pipe(Effect.andThen(fs.realPath(target))),
            stat: (target) => Effect.sync(() => accessed.push(target)).pipe(Effect.andThen(fs.stat(target))),
            open: (target, options) =>
              Effect.sync(() => accessed.push(target)).pipe(Effect.andThen(fs.open(target, options))),
            readFile: (target) => Effect.sync(() => accessed.push(target)).pipe(Effect.andThen(fs.readFile(target))),
            readFileString: (target, encoding) =>
              Effect.sync(() => accessed.push(target)).pipe(Effect.andThen(fs.readFileString(target, encoding))),
          }),
        },
        (runtime) =>
          Effect.gen(function* () {
            for (const operation of LSPV2.operations) {
              const result = yield* runtime.query(position(input.filePath, operation))
              expect(result.server).toBe("fixture")
              if (operation === "hover" || operation === "documentSymbol") {
                expect(result.omitted).toBe(0)
                continue
              }
              expect(result.result).toHaveLength(operation === "incomingCalls" || operation === "outgoingCalls" ? 4 : 2)
              expect(JSON.stringify(result.result)).toContain("outside.ts")
              expect(result.omitted).toBe(0)
              if (operation.includes("Calls")) expect(JSON.stringify(result.result)).toContain("preserve-me")
            }
          }),
      )
      expect(accessed.length).toBeGreaterThan(0)
      expect(accessed.every((target) => target === input.directory || target === input.filePath)).toBe(true)
    } finally {
      await input.close()
    }
  })

  it("keeps undefined and false disabled and reports missing files or invalid custom configs without starting", async () => {
    const input = await setup()
    try {
      for (const configuration of [undefined, false]) {
        const result = await run(
          input,
          (runtime) => Effect.result(runtime.query(position(input.filePath))),
          configuration,
        )
        expect(result._tag === "Failure" && result.failure.kind).toBe("disabled")
      }
      await run(input, (runtime) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(runtime.query(position(path.join(input.directory, "missing.ts"))))
          expect(result._tag === "Failure" && result.failure.kind).toBe("path")
        }),
      )
      const invalid = await run(input, (runtime) => Effect.result(runtime.query(position(input.filePath))), {
        custom: new ConfigLSP.Server({ command: [process.execPath, fixture] }),
      })
      expect(invalid._tag === "Failure" && invalid.failure.kind).toBe("configuration")
      expect(input.events).toHaveLength(0)
    } finally {
      await input.close()
    }
  })

  it("retains virtual URI metadata for locations, links, symbols and call hierarchy", async () => {
    const input = await setup()
    const uri = "git:/virtual/project/file.ts?ref=HEAD"
    try {
      await run(
        {
          ...input,
          fs: (fs) => ({
            ...fs,
            realPath: (target) => {
              expect([input.directory, input.filePath]).toContain(target)
              return fs.realPath(target)
            },
          }),
        },
        (runtime) =>
          Effect.gen(function* () {
            for (const operation of LSPV2.operations.filter(
              (value) => value !== "hover" && value !== "documentSymbol",
            )) {
              const result = yield* runtime.query(position(input.filePath, operation))
              expect(result.omitted).toBe(0)
              expect(JSON.stringify(result.result)).toContain(uri)
            }
          }),
        {
          fixture: new ConfigLSP.Server({
            command: [process.execPath, fixture],
            extensions: ["ts"],
            env: { ...input.configuration.fixture.env, LSP_RESULT_URI: uri },
          }),
        },
      )
    } finally {
      await input.close()
    }
  })

  it("reports malformed location metadata and invalid URIs as typed protocol failures", async () => {
    const input = await setup("invalid-result")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          for (const operation of ["goToDefinition", "workspaceSymbol", "prepareCallHierarchy"] as const) {
            const result = yield* Effect.result(runtime.query(position(input.filePath, operation)))
            expect(result._tag === "Failure" && result.failure.kind).toBe("protocol")
          }
        }),
      )
      const result = await run(
        input,
        (runtime) => Effect.result(runtime.query(position(input.filePath, "goToDefinition"))),
        {
          fixture: new ConfigLSP.Server({
            command: [process.execPath, fixture],
            extensions: ["ts"],
            env: { ...input.configuration.fixture.env, LSP_MODE: "normal", LSP_RESULT_URI: "not a URI" },
          }),
        },
      )
      expect(result._tag === "Failure" && result.failure.kind).toBe("protocol")
    } finally {
      await input.close()
    }
  })

  it("opens explicitly requested external files on the same server without changing its configured project root", async () => {
    const input = await setup("diag-pull")
    const outside = await realpath(await mkdtemp(path.join(tmpdir(), "cudia-lsp-external-")))
    const filePath = path.join(outside, "file.ts")
    await writeFile(filePath, "const external = 1\r\n")
    await writeFile(path.join(outside, "opencode.json"), JSON.stringify({ lsp: false }))
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          const external = text(yield* runtime.query(position(filePath)))
          expect(external.document.text).toBe("const external = 1\r\n")
          const local = text(yield* runtime.query(position(input.filePath)))
          expect(local.pid).toBe(external.pid)
          const diagnostic = yield* runtime.diagnostics({ filePath })
          expect(diagnostic).toMatchObject({ filePath, source: "pull", freshness: "current", version: 1 })
          const initialized = yield* Effect.promise(() => input.wait((event) => event.method === "initialize"))
          expect(initialized.params).toMatchObject({
            rootUri: pathToFileURL(input.directory).href,
            workspaceFolders: [{ uri: pathToFileURL(input.directory).href, name: input.directory }],
          })
          expect(input.events.find((event) => event.type === "started")?.cwd).toBe(input.directory)
          expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
          expect(input.events.filter((event) => event.type === "started")).toHaveLength(1)
          const missing = yield* Effect.result(runtime.query(position(path.join(outside, "missing.ts"))))
          expect(missing._tag === "Failure" && missing.failure.kind).toBe("path")
        }),
      )
    } finally {
      await input.close()
      await rm(outside, { recursive: true, force: true })
    }
  })

  it("reports unavailable builtins truthfully without installing", async () => {
    const input = await setup()
    try {
      const result = await run(
        input,
        (runtime) => Effect.result(runtime.query({ ...position(input.filePath), filePath: input.filePath })),
        { fixture: new ConfigLSP.Server({ command: ["cudia-lsp-does-not-exist-12345"], extensions: ["ts"] }) },
      )
      expect(result._tag === "Failure" && result.failure.kind).toBe("unavailable")
      expect(input.events).toHaveLength(0)
    } finally {
      await input.close()
    }
  })

  it("reports unsupported capability instead of an empty result or query RPC", async () => {
    const input = await setup("unsupported")
    try {
      const result = await run(input, (runtime) => Effect.result(runtime.query(position(input.filePath))))
      expect(result._tag === "Failure" && result.failure.kind).toBe("unsupported")
      expect(input.events.filter((event) => event.method === "textDocument/hover")).toHaveLength(0)
      expect(input.events.filter((event) => event.method === "textDocument/didOpen")).toHaveLength(0)
    } finally {
      await input.close()
    }
  })

  for (const mode of ["init-hang", "oversized", "malformed", "early-exit", "encoding", "partial"]) {
    it(`cleans up the owned child after ${mode} without replay`, async () => {
      const input = await setup(mode)
      try {
        const result = await run(input, (runtime) => Effect.result(runtime.query(position(input.filePath))))
        expect(result._tag).toBe("Failure")
        const started = await input.wait((event) => event.type === "started")
        expect(() => process.kill(started.pid!, 0)).toThrow()
        expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
      } finally {
        await input.close()
      }
    })
  }

  it("cancels a held request, keeps a multiplexed peer alive, and ignores a late result", async () => {
    const input = await setup("hold")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          const pending = yield* runtime.query(position(input.filePath)).pipe(Effect.forkChild)
          const held = yield* Effect.promise(() => input.wait((event) => event.type === "held"))
          const queued = []
          for (let index = 0; index < 15; index++)
            queued.push(yield* runtime.query(position(input.filePath)).pipe(Effect.forkChild))
          yield* Effect.yieldNow
          const overflow = yield* Effect.result(runtime.query(position(input.filePath, "workspaceSymbol")))
          expect(overflow._tag === "Failure" && overflow.failure.kind).toBe("budget")
          yield* Effect.forEach(queued, Fiber.interrupt, { discard: true })
          yield* Fiber.interrupt(pending)
          yield* Effect.promise(() => input.wait((event) => event.method === "$/cancelRequest"))
          const peer = yield* runtime.query(position(input.filePath, "workspaceSymbol"))
          expect(peer.result).toHaveLength(2)
          input.holds.get(held.id!)!()
          const after = yield* runtime.query(position(input.filePath, "goToDefinition"))
          expect(after.result).toHaveLength(2)
          expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
        }),
      )
    } finally {
      await input.close()
    }
  })

  it("rejects server requested edits and keeps the file unchanged", async () => {
    const input = await setup("apply-edit")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          yield* runtime.query(position(input.filePath))
          const response = yield* Effect.promise(() => input.wait((event) => event.type === "server-response"))
          expect(JSON.stringify(response.message)).toContain("cannot edit files")
        }),
      )
      expect(await Bun.file(input.filePath).text()).toBe("const 😀name = 1\r\ncall()\r\n")
    } finally {
      await input.close()
    }
  })

  it("times out repeated nonresponding requests without exhausting the library pending map", async () => {
    const input = await setup("hang")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const process = yield* Service
            const client = yield* LSPClient.open({
              process,
              command: [processExec(), fixture],
              directory: input.directory,
              rootURI: pathToFileURL(input.directory).href,
              env: input.configuration.fixture.env,
              timeout: { startup: 3000, request: 20 },
            })
            for (let index = 0; index < LSPClient.MAX_PENDING + 4; index++) {
              const result = yield* Effect.result(client.request("textDocument/hover", { index }))
              expect(result._tag === "Failure" && result.failure.kind).toBe("timeout")
            }
            const peer = yield* client.request("workspace/symbol", { query: "" })
            expect(peer).toBeArray()
          }),
        ).pipe(Effect.provide(layer)),
      )
    } finally {
      await input.close()
    }
  })

  it("bounds a backpressured writer and cancels queued requests before stdin resumes", async () => {
    const input = await setup("backpressure")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const process = yield* Service
            const client = yield* LSPClient.open({
              process,
              command: [processExec(), fixture],
              directory: input.directory,
              rootURI: pathToFileURL(input.directory).href,
              env: input.configuration.fixture.env,
              timeout: { startup: 3000, request: 3000 },
            })
            yield* Effect.promise(() => input.wait((event) => event.type === "held" && event.id === -1))
            const payload = { text: "x".repeat(3 * 1024 * 1024) }
            const first = yield* client.request("probe/first", payload).pipe(Effect.forkChild)
            // A query that does not need stdin is a scheduling barrier after the first write starts.
            yield* Effect.yieldNow
            const second = yield* client.request("probe/queued", payload).pipe(Effect.forkChild)
            yield* Effect.yieldNow
            const overflow = yield* Effect.result(client.request("probe/overflow", payload))
            expect(overflow._tag === "Failure" && overflow.failure.kind).toBe("budget")
            yield* Fiber.interrupt(second)
            yield* Fiber.interrupt(first)
            // Both interruptions have completed while the child is still paused.
            expect(input.holds.has(-1)).toBe(true)
            input.holds.get(-1)!()
            yield* Effect.promise(() => input.wait((event) => event.method === "probe/first"))
            const peer = yield* client.request("workspace/symbol", { query: "" })
            expect(peer).toBeArray()
            expect(input.events.some((event) => event.method === "probe/queued")).toBe(false)
            expect(input.events.some((event) => event.method === "probe/overflow")).toBe(false)
          }),
        ).pipe(Effect.provide(layer)),
      )
    } finally {
      await input.close()
    }
  })

  it("cleans a post-initialize protocol failure before the Location closes", async () => {
    const input = await setup("post-malformed")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          const failed = yield* Effect.result(runtime.query(position(input.filePath)))
          expect(failed._tag === "Failure" && failed.failure.kind).toBe("protocol")
          expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
          const started = yield* Effect.promise(() => input.wait((event) => event.type === "started"))
          expect(() => process.kill(started.pid!, 0)).toThrow()
        }),
      )
      const started = await input.wait((event) => event.type === "started")
      expect(() => process.kill(started.pid!, 0)).toThrow()
    } finally {
      await input.close()
    }
  })

  it("rejects deep server JSON as a typed protocol failure", async () => {
    const input = await setup("deep")
    try {
      const result = await run(input, (runtime) => Effect.result(runtime.query(position(input.filePath))))
      expect(result._tag === "Failure" && result.failure.kind).toBe("protocol")
    } finally {
      await input.close()
    }
  })

  it("bounds simultaneous pending requests and survives response, cancellation and close races", async () => {
    const input = await setup("hold")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const process = yield* Service
            const scope = yield* Scope.make()
            const client = yield* LSPClient.open({
              process,
              command: [processExec(), fixture],
              directory: input.directory,
              rootURI: pathToFileURL(input.directory).href,
              env: input.configuration.fixture.env,
              timeout: { startup: 3000, request: 3000 },
            }).pipe(Effect.provideService(Scope.Scope, scope))
            const fibers = []
            for (let index = 0; index < LSPClient.MAX_PENDING; index++) {
              fibers.push(
                yield* client
                  .request("textDocument/hover", { textDocument: { uri: pathToFileURL(input.filePath).href } })
                  .pipe(Effect.forkChild),
              )
            }
            yield* Effect.promise(() => input.wait(() => input.holds.size === LSPClient.MAX_PENDING))
            const overflow = yield* Effect.result(client.request("workspace/symbol", { query: "" }))
            expect(overflow._tag === "Failure" && overflow.failure.kind).toBe("budget")
            // Release responses and cancel their matching callers in the same turn.
            input.holds.forEach((release) => release())
            yield* Effect.forEach(fibers.slice(0, 16), Fiber.interrupt, { concurrency: "unbounded", discard: true })
            yield* Effect.forEach(fibers.slice(16), (fiber) => Fiber.await(fiber), { discard: true })
            expect(yield* client.request("workspace/symbol", { query: "" })).toBeArray()
            const pending = yield* client
              .request("textDocument/hover", { textDocument: { uri: pathToFileURL(input.filePath).href } })
              .pipe(Effect.forkChild)
            yield* Effect.promise(() => input.wait(() => input.holds.size === 1))
            input.holds.forEach((release) => release())
            yield* Scope.close(scope, Exit.void)
            yield* Fiber.await(pending)
            const closed = yield* Effect.result(client.request("workspace/symbol", { query: "" }))
            expect(closed._tag === "Failure" && closed.failure.kind).toBe("closed")
          }),
        ).pipe(Effect.provide(layer)),
      )
    } finally {
      await input.close()
    }
  })

  it("discards notification bursts and drains 1 MiB of stderr without blocking initialization", async () => {
    const input = await setup("notification-burst")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          const result = text(yield* runtime.query(position(input.filePath)))
          expect(result.document.version).toBe(1)
          expect(yield* runtime.query(position(input.filePath, "workspaceSymbol"))).toMatchObject({
            server: "fixture",
            omitted: 0,
          })
          expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
        }),
      )
    } finally {
      await input.close()
    }
  })

  it("fails closed on a server request burst before the library queue grows", async () => {
    const input = await setup("request-burst")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          const result = yield* Effect.result(runtime.query(position(input.filePath)))
          expect(result._tag === "Failure" && result.failure.kind).toBe("protocol")
          const started = yield* Effect.promise(() => input.wait((event) => event.type === "started"))
          expect(() => processKill(started.pid!)).toThrow()
          const repeated = yield* Effect.result(runtime.query(position(input.filePath)))
          expect(repeated._tag === "Failure" && repeated.failure.kind).toBe("protocol")
          expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
        }),
      )
    } finally {
      await input.close()
    }
  })

  it("joins every caller and removes the owned child when its Location closes during initialization", async () => {
    const input = await setup("init-hang")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const process = yield* Service
            const scope = yield* Scope.make()
            const runtime = yield* LSPV2.make({
              directory: input.directory,
              configuration: input.configuration,
              fs,
              process,
              timeout: { startup: 10_000, request: 3_000 },
            }).pipe(Effect.provideService(Scope.Scope, scope))
            const callers = []
            for (let index = 0; index < 3; index++)
              callers.push(yield* runtime.query(position(input.filePath)).pipe(Effect.forkChild))
            const started = yield* Effect.promise(() => input.wait((event) => event.type === "started"))
            yield* Effect.promise(() => input.wait((event) => event.method === "initialize"))
            yield* Scope.close(scope, Exit.void)
            const exits = yield* Effect.forEach(callers, Fiber.await)
            expect(exits.every(Exit.isFailure)).toBe(true)
            expect(() => processKill(started.pid!)).toThrow()
            const closed = yield* Effect.result(runtime.query(position(input.filePath)))
            expect(closed._tag === "Failure" && closed.failure.kind).toBe("closed")
            expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
          }),
        ).pipe(Effect.provide(layer)),
      )
    } finally {
      await input.close()
    }
  })

  it("closes a paused stdin with active and queued writes without resuming the child", async () => {
    const input = await setup("backpressure")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const process = yield* Service
            const scope = yield* Scope.make()
            const client = yield* LSPClient.open({
              process,
              command: [processExec(), fixture],
              directory: input.directory,
              rootURI: pathToFileURL(input.directory).href,
              env: input.configuration.fixture.env,
              timeout: { startup: 3_000, request: 10_000 },
            }).pipe(Effect.provideService(Scope.Scope, scope))
            yield* Effect.promise(() => input.wait((event) => event.type === "held" && event.id === -1))
            const payload = { text: "x".repeat(3 * 1024 * 1024) }
            const first = yield* client.request("probe/first", payload).pipe(Effect.forkChild)
            yield* Effect.yieldNow
            const second = yield* client.request("probe/queued", payload).pipe(Effect.forkChild)
            yield* Effect.yieldNow
            const overflow = yield* Effect.result(client.request("probe/overflow", payload))
            expect(overflow._tag === "Failure" && overflow.failure.kind).toBe("budget")
            expect(input.holds.has(-1)).toBe(true)
            yield* Scope.close(scope, Exit.void)
            const exits = yield* Effect.forEach([first, second], Fiber.await)
            expect(exits.every(Exit.isFailure)).toBe(true)
            expect(input.holds.has(-1)).toBe(true)
            const started = yield* Effect.promise(() => input.wait((event) => event.type === "started"))
            expect(() => processKill(started.pid!)).toThrow()
            expect(
              input.events.some((event) => event.method === "probe/first" || event.method === "probe/queued"),
            ).toBe(false)
            const closed = yield* Effect.result(client.request("workspace/symbol", { query: "" }))
            expect(closed._tag === "Failure" && closed.failure.kind).toBe("closed")
          }),
        ).pipe(Effect.provide(layer)),
      )
    } finally {
      await input.close()
    }
  })

  it("cancels one initialization waiter while the other callers share one successful initialization", async () => {
    const input = await setup("init-hold")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          const callers = []
          for (let index = 0; index < 3; index++)
            callers.push(yield* runtime.query(position(input.filePath)).pipe(Effect.forkChild))
          yield* Effect.promise(() => input.wait((event) => event.type === "held" && event.id === -2))
          yield* Fiber.interrupt(callers[0]!)
          input.holds.get(-2)!()
          const first = yield* Fiber.await(callers[0]!)
          expect(Exit.isFailure(first)).toBe(true)
          for (const caller of callers.slice(1)) expect(Exit.isSuccess(yield* Fiber.await(caller))).toBe(true)
          expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
        }),
      )
    } finally {
      await input.close()
    }
  })

  it("shares an initialization failure among callers and does not automatically replay it", async () => {
    const input = await setup("oversized")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          const callers = []
          for (let index = 0; index < 3; index++)
            callers.push(yield* Effect.result(runtime.query(position(input.filePath))).pipe(Effect.forkChild))
          for (const caller of callers) {
            const exit = yield* Fiber.await(caller)
            expect(Exit.isSuccess(exit) && exit.value._tag === "Failure" && exit.value.failure.kind).toBe("protocol")
          }
          const repeated = yield* Effect.result(runtime.query(position(input.filePath)))
          expect(repeated._tag === "Failure" && repeated.failure.kind).toBe("protocol")
          expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
        }),
      )
    } finally {
      await input.close()
    }
  })

  it("closes before a scheduled query starts without spawning a child or leaving its caller pending", async () => {
    const input = await setup("init-hang")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const process = yield* Service
            const scope = yield* Scope.make()
            const runtime = yield* LSPV2.make({
              directory: input.directory,
              configuration: input.configuration,
              fs,
              process,
            }).pipe(Effect.provideService(Scope.Scope, scope))
            const caller = yield* Effect.result(runtime.query(position(input.filePath))).pipe(Effect.forkChild)
            yield* Scope.close(scope, Exit.void)
            const exit = yield* Fiber.await(caller)
            expect(Exit.isSuccess(exit) && exit.value._tag === "Failure" && exit.value.failure.kind).toBe("closed")
            expect(input.events).toHaveLength(0)
          }),
        ).pipe(Effect.provide(layer)),
      )
    } finally {
      await input.close()
    }
  })

  it("bounds retained readiness reactions during successive initialization waiter cancellations", async () => {
    const input = await setup("init-hold")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const process = yield* Service
            let observed: (() => void) | undefined
            const filesystem = {
              ...fs,
              realPath: (target: string) =>
                fs.realPath(target).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (target === input.filePath) observed?.()
                    }),
                  ),
                ),
            }
            const runtime = yield* LSPV2.make({
              directory: input.directory,
              configuration: input.configuration,
              fs: filesystem,
              process,
              timeout: { startup: 3_000, request: 1_000 },
            })
            const first = yield* runtime.query(position(input.filePath)).pipe(Effect.forkChild)
            yield* Effect.promise(() => input.wait((event) => event.type === "held" && event.id === -2))
            for (let index = 0; index < 31; index++) {
              const selected = new Promise<void>((resolve) => {
                observed = resolve
              })
              const caller = yield* runtime.query(position(input.filePath)).pipe(Effect.forkChild)
              // The real canonical lookup completes in the query's Effect turn. Its
              // Promise reaction runs after that turn installs the readiness wait.
              yield* Effect.promise(() => selected)
              observed = undefined
              yield* Fiber.interrupt(caller)
            }
            const overflow = yield* Effect.result(runtime.query(position(input.filePath)))
            expect(overflow._tag === "Failure" && overflow.failure.kind).toBe("budget")
            expect(input.holds.has(-2)).toBe(true)
            input.holds.get(-2)!()
            expect(Exit.isSuccess(yield* Fiber.await(first))).toBe(true)
            expect((yield* runtime.query(position(input.filePath))).server).toBe("fixture")
            expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
          }),
        ).pipe(Effect.provide(layer)),
      )
    } finally {
      await input.close()
    }
  })
})

function processExec() {
  return process.execPath
}
function processKill(pid: number) {
  return process.kill(pid, 0)
}

describe("bounded LSP framing", () => {
  it("handles fragmented UTF-8 and rejects oversized, duplicate, malformed headers and invalid JSON", () => {
    const messages: unknown[] = []
    const consume = LSPFraming.parser((value) => messages.push(value))
    const bytes = LSPFraming.frame({ jsonrpc: "2.0", id: 1, result: "😀" })
    for (const byte of bytes) consume(Uint8Array.of(byte))
    expect(messages).toEqual([{ jsonrpc: "2.0", id: 1, result: "😀" }])
    for (const invalid of [
      "Content-Length: 99999999\r\n\r\n",
      "Content-Length: 2\r\nContent-Length: 2\r\n\r\n{}",
      "Content-Length: nope\r\n\r\n",
      "Content-Length: 4\r\n\r\nnope",
      "x".repeat(LSPFraming.MAX_HEADER_BYTES + 1),
    ])
      expect(() => LSPFraming.parser(() => {})(Buffer.from(invalid))).toThrow()
  })
})
