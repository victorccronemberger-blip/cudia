import { describe, expect, it } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect"
import { mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigLSP } from "../src/config/lsp"
import { FSUtil } from "../src/fs-util"
import { LayerNode } from "../src/effect/layer-node"
import { LSPV2 } from "../src/lsp"
import { LSPMutation } from "../src/lsp/mutation"
import { Service, node } from "../src/process"

const layer = Layer.merge(LayerNode.compile(FSUtil.node), LayerNode.compile(node))
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
const report = (filePath: string): LSPV2.DiagnosticResult => ({
  filePath,
  server: "fixture",
  source: "push",
  freshness: "current",
  version: 1,
  generation: 1,
  diagnostics: [{ range, message: "problem", severity: 1 }],
  omitted: 0,
})
function service(overrides: Partial<LSPV2.Interface> = {}): LSPV2.Interface {
  return LSPV2.Service.of({
    supports: () => Effect.succeed(true),
    query: () => Effect.die("unused query"),
    diagnostics: ({ filePath }) => Effect.succeed(report(filePath)),
    forget: () => Effect.void,
    didClose: () => Effect.void,
    status: () => Effect.die("unused status"),
    ...overrides,
  })
}
const change = (filePath: string, kind: LSPMutation.Change["kind"] = "changed") => ({ filePath, kind })

async function native(mode: string) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "cudia-lsp-mutation-")))
  const filePath = path.join(directory, "file.ts")
  await writeFile(filePath, "bad first text\n")
  const events: { type: string; method?: string; id?: number }[] = []
  const holds = new Map<number, () => void>()
  const watchers = new Set<() => void>()
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const event = (await request.json()) as (typeof events)[number] & { id: number }
      if (new URL(request.url).pathname === "/hold")
        return new Promise<Response>((resolve) => {
          holds.set(event.id, () => {
            holds.delete(event.id)
            resolve(new Response("release"))
          })
          events.push({ type: "held", id: event.id })
          watchers.forEach((notify) => notify())
        })
      events.push(event)
      watchers.forEach((notify) => notify())
      return new Response("ok")
    },
  })
  const wait = (predicate: (event: (typeof events)[number]) => boolean) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        watchers.delete(check)
        reject(new Error("LSP mutation fixture barrier timed out"))
      }, 4000)
      const check = () => {
        if (!events.some(predicate)) return
        clearTimeout(timer)
        watchers.delete(check)
        resolve()
      }
      watchers.add(check)
      check()
    })
  const configuration = {
    fixture: new ConfigLSP.Server({
      command: [process.execPath, path.join(import.meta.dir, "lsp-fixtures", "stdio.js")],
      extensions: ["ts"],
      env: { LSP_MODE: mode, LSP_CONTROL: control.url.href.replace(/\/$/, "") },
    }),
  }
  return {
    directory,
    filePath,
    events,
    holds,
    wait,
    configuration,
    async close() {
      holds.forEach((release) => release())
      await control.stop(true)
      await rm(directory, { recursive: true, force: true })
    },
  }
}
function run<A, E>(input: Awaited<ReturnType<typeof native>>, body: (lsp: LSPV2.Interface) => Effect.Effect<A, E>) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const process = yield* Service
        const lsp = yield* LSPV2.make({
          directory: input.directory,
          configuration: input.configuration,
          fs,
          process,
          timeout: { startup: 3000, request: 1000 },
        })
        return yield* body(lsp)
      }),
    ).pipe(Effect.provide(layer)),
  )
}

describe("post-write LSP followup", () => {
  it("does nothing when disabled or no changes were committed", async () => {
    const lsp = service({
      forget: () => Effect.die("forget"),
      supports: () => Effect.die("supports"),
      diagnostics: () => Effect.die("diagnostics"),
      didClose: () => Effect.die("close"),
    })
    expect(
      await Effect.runPromise(LSPMutation.make({ lsp, enabled: false }).after([change("file.ts")])),
    ).toBeUndefined()
    expect(await Effect.runPromise(LSPMutation.make({ lsp, enabled: true }).after([]))).toBeUndefined()
    expect(LSPMutation.format(undefined)).toBe("")
  })

  it("deduplicates latest changes, invalidates the entire tail and selects four supported candidates", async () => {
    const calls: string[] = []
    const changes = [
      change("README.md"),
      change("first.ts"),
      change("second.ts"),
      change("third.ts"),
      change("fourth.ts"),
      change("tail.ts"),
      change("first.ts", "deleted"),
    ]
    const lsp = service({
      forget: (item) =>
        Effect.sync(() => {
          calls.push(`forget:${item.filePath}:${item.kind}`)
        }),
      supports: (item) =>
        Effect.sync(() => {
          calls.push(`supports:${item.filePath}`)
          return item.filePath.endsWith(".ts")
        }),
      didClose: (item) =>
        Effect.sync(() => {
          calls.push(`close:${item.filePath}`)
        }),
      diagnostics: (item) =>
        Effect.sync(() => {
          calls.push(`diagnostics:${item.filePath}`)
          return report(item.filePath)
        }),
    })
    const result = await Effect.runPromise(LSPMutation.make({ lsp, enabled: true }).after(changes))
    expect(calls.slice(0, 6)).toEqual([
      "forget:README.md:changed",
      "forget:first.ts:deleted",
      "forget:second.ts:changed",
      "forget:third.ts:changed",
      "forget:fourth.ts:changed",
      "forget:tail.ts:changed",
    ])
    expect(result).toMatchObject({ omittedFiles: 1, unsupportedFiles: 1, timedOut: false })
    expect(result?.files).toHaveLength(4)
    expect(result?.files[0]).toEqual({ filePath: "first.ts", state: "closed" })
    expect(calls).not.toContain("diagnostics:tail.ts")
    expect(calls).not.toContain("diagnostics:first.ts")
  })

  it("counts unsupported files without a query and preserves a later supported candidate", async () => {
    const calls: string[] = []
    const result = await Effect.runPromise(
      LSPMutation.make({
        enabled: true,
        lsp: service({
          supports: ({ filePath }) => Effect.succeed(filePath.endsWith(".ts")),
          diagnostics: ({ filePath }) =>
            Effect.sync(() => {
              calls.push(filePath)
              return report(filePath)
            }),
        }),
      }).after([change("one.md"), change("two.json"), change("three.txt"), change("four.xml"), change("later.ts")]),
    )
    expect(result).toMatchObject({ unsupportedFiles: 4, omittedFiles: 0, timedOut: false })
    expect(calls).toEqual(["later.ts"])
    const unsupported = await Effect.runPromise(
      LSPMutation.make({
        enabled: true,
        lsp: service({
          supports: () => Effect.succeed(false),
          diagnostics: () => Effect.die("must not query"),
        }),
      }).after([change("one.md"), change("two.txt")]),
    )
    expect(unsupported).toBeUndefined()
  })

  if (process.platform === "win32")
    it("deduplicates canonical Windows paths without changing the latest identity", async () => {
      const forgotten: LSPMutation.Change[] = []
      const result = await Effect.runPromise(
        LSPMutation.make({
          enabled: true,
          lsp: service({
            forget: (item) =>
              Effect.sync(() => {
                forgotten.push(item)
              }),
          }),
        }).after([change("C:\\one.ts"), change("c:\\ONE.ts", "deleted")]),
      )
      expect(forgotten).toEqual([change("c:\\ONE.ts", "deleted")])
      expect(result?.files).toEqual([{ filePath: "c:\\ONE.ts", state: "closed" }])
    })

  it("invalidates every file before a stalled first close and cancels it on the shared deadline", async () => {
    const calls: string[] = []
    let interrupted = false
    const result = await Effect.runPromise(
      LSPMutation.make({
        enabled: true,
        timeout: 30,
        lsp: service({
          forget: (item) =>
            Effect.sync(() => {
              calls.push(`forget:${item.filePath}`)
            }),
          didClose: () =>
            Effect.sync(() => {
              calls.push("close")
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true
                }),
              ),
            ),
          supports: () => Effect.die("must not continue after stalled close"),
        }),
      }).after([change("deleted.ts", "deleted"), change("later.ts"), change("tail.ts")]),
    )
    expect(calls).toEqual(["forget:deleted.ts", "forget:later.ts", "forget:tail.ts", "close"])
    expect(result).toEqual({ files: [], omittedFiles: 3, unsupportedFiles: 0, timedOut: true })
    expect(interrupted).toBe(true)
  })

  it("uses one budget for all files and never continues the interrupted query", async () => {
    const calls: string[] = []
    let cancelled = 0
    const result = await Effect.runPromise(
      LSPMutation.make({
        enabled: true,
        timeout: 100,
        lsp: service({
          diagnostics: ({ filePath }) =>
            Effect.sync(() => {
              calls.push(filePath)
            }).pipe(
              Effect.andThen(Effect.sleep(65)),
              Effect.as(report(filePath)),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  cancelled++
                }),
              ),
            ),
        }),
      }).after([change("one.ts"), change("two.ts"), change("three.ts")]),
    )
    expect(calls).toEqual(["one.ts", "two.ts"])
    expect(result?.files).toHaveLength(1)
    expect(result).toMatchObject({ timedOut: true, omittedFiles: 2 })
    expect(cancelled).toBe(1)
  })

  it("keeps typed failures informational and preserves pending or unversioned freshness", async () => {
    const result = await Effect.runPromise(
      LSPMutation.make({
        enabled: true,
        lsp: service({
          supports: ({ filePath }) =>
            filePath === "invalid.ts"
              ? Effect.fail(new LSPV2.Failure({ kind: "configuration", message: "secret" }))
              : Effect.succeed(true),
          diagnostics: ({ filePath }) =>
            filePath === "missing.ts"
              ? Effect.fail(new LSPV2.Failure({ kind: "unavailable", message: "private binary command" }))
              : Effect.succeed({
                  ...report(filePath),
                  diagnostics: [],
                  freshness: filePath === "pending.ts" ? "pending" : "unversioned",
                  source: "none",
                }),
        }),
      }).after([change("invalid.ts"), change("missing.ts"), change("pending.ts"), change("versionless.ts")]),
    )
    expect(result?.files.slice(0, 2)).toEqual([
      { filePath: "invalid.ts", state: "error", failure: "configuration" },
      { filePath: "missing.ts", state: "error", failure: "unavailable" },
    ])
    expect(result?.files[2]).toMatchObject({ state: "reported", freshness: "pending", diagnostics: [] })
    expect(result?.files[3]).toMatchObject({ state: "reported", freshness: "unversioned", diagnostics: [] })
    expect(LSPMutation.format(result)).not.toContain("private binary")
    expect(LSPMutation.format(result)).not.toContain("clean")
  })

  it("preserves caller interruption and defects", async () => {
    let started: (() => void) | undefined
    const barrier = new Promise<void>((resolve) => {
      started = resolve
    })
    const lsp = service({ diagnostics: () => Effect.sync(() => started?.()).pipe(Effect.andThen(Effect.never)) })
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pending = yield* LSPMutation.make({ lsp, enabled: true })
            .after([change("one.ts")])
            .pipe(Effect.forkChild)
          yield* Effect.promise(() => barrier)
          yield* Fiber.interrupt(pending)
          return yield* Fiber.await(pending)
        }),
      ),
    )
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    const defect = await Effect.runPromise(
      LSPMutation.make({
        enabled: true,
        lsp: service({
          supports: () => Effect.die(new Error("intentional defect")),
        }),
      })
        .after([change("one.ts")])
        .pipe(Effect.exit),
    )
    expect(Exit.isFailure(defect) && Cause.prettyErrors(defect.cause).join(" ").includes("intentional defect")).toBe(
      true,
    )
  })

  it("bounds aggregate diagnostics and escaped Unicode JSON including complete metadata", async () => {
    for (const message of ["short", '\u0000"\\😀'.repeat(1000)]) {
      const result = await Effect.runPromise(
        LSPMutation.make({
          enabled: true,
          lsp: service({
            diagnostics: ({ filePath }) =>
              Effect.succeed({
                ...report(filePath),
                omitted: 3,
                diagnostics: Array.from({ length: 100 }, () => ({ range, message, code: "E1" })),
              }),
          }),
        }).after(Array.from({ length: 6 }, (_, index) => change(`C:\\space [${index}]\\ação.ts`))),
      )
      expect(result).toBeDefined()
      Schema.decodeUnknownSync(LSPMutation.Result)(result)
      expect(result?.files).toHaveLength(4)
      expect(result?.omittedFiles).toBe(2)
      const items = result!.files.flatMap((file) => (file.state === "reported" ? file.diagnostics : []))
      expect(items.length).toBeLessThanOrEqual(20)
      expect(items.length).toBeGreaterThan(0)
      for (const item of items) {
        expect(Buffer.byteLength(item.message)).toBeLessThanOrEqual(512)
        expect(item.message).not.toContain("�")
        if (message !== "short") expect(item.messageTruncated).toBe(true)
      }
      expect(Buffer.byteLength(LSPMutation.format(result))).toBeLessThanOrEqual(8192)
      expect(
        result!.files.reduce((sum, file) => sum + (file.state === "reported" ? file.omittedDiagnostics : 0), 0),
      ).toBe(400 - items.length)
    }
  })

  it("omits oversized identities and oversized-code diagnostics without truncating their identity", async () => {
    const huge = `C:\\${'😀\\"'.repeat(5000)}.ts`
    const result = await Effect.runPromise(
      LSPMutation.make({
        enabled: true,
        lsp: service({
          diagnostics: ({ filePath }) =>
            Effect.succeed({
              ...report(filePath),
              diagnostics: [
                { range, message: "hidden code", code: "x".repeat(513) },
                { range, message: "kept", code: 123 },
              ],
            }),
        }),
      }).after([change(huge), change("exact.ts")]),
    )
    expect(result).toMatchObject({ omittedFiles: 1, unsupportedFiles: 0 })
    expect(result?.files).toHaveLength(1)
    expect(result?.files[0]).toMatchObject({
      filePath: "exact.ts",
      omittedDiagnostics: 1,
      diagnostics: [{ message: "kept", code: 123 }],
    })
    expect(Buffer.byteLength(LSPMutation.format(result))).toBeLessThanOrEqual(8192)
    const external = LSPMutation.format({
      files: [{ filePath: huge, state: "closed" }],
      omittedFiles: 2,
      unsupportedFiles: 1,
      timedOut: false,
    })
    expect(Buffer.byteLength(external)).toBeLessThanOrEqual(8192)
    expect(JSON.parse(external.slice("\n\nPost-write LSP: ".length))).toEqual({
      files: [],
      omittedFiles: 3,
      unsupportedFiles: 1,
      timedOut: false,
    })
  })

  it("checks suitability without reading files, looking up executables or starting children", async () => {
    const input = await native("diag-push")
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const process = yield* Service
            for (const configuration of [
              undefined,
              false,
              true,
              input.configuration,
              { invalid: new ConfigLSP.Server({ command: ["missing"] }) },
            ]) {
              const lsp = yield* LSPV2.make({
                directory: input.directory,
                configuration,
                fs: {
                  ...fs,
                  realPath: () => Effect.die("no filesystem normalization"),
                  open: () => Effect.die("no reads"),
                },
                process: { ...process, spawn: () => Effect.die("no process startup") },
              })
              const result = yield* Effect.result(lsp.supports({ filePath: input.filePath }))
              if (configuration && typeof configuration === "object" && "invalid" in configuration)
                expect(result._tag === "Failure" && result.failure.kind).toBe("configuration")
              else expect(result._tag === "Success" && result.success).toBe(Boolean(configuration))
              if (configuration === true) {
                expect(yield* lsp.supports({ filePath: "module.MTS" })).toBe(true)
                expect(yield* lsp.supports({ filePath: "README" })).toBe(false)
              }
            }
            expect(input.events).toHaveLength(0)
          }),
        ).pipe(Effect.provide(layer)),
      )
    } finally {
      await input.close()
    }
  })

  it("refreshes actual stdio diagnostics after a physical write and only closes a deleted document", async () => {
    const input = await native("diag-push")
    try {
      await run(input, (lsp) =>
        Effect.gen(function* () {
          const before = yield* lsp.diagnostics({ filePath: input.filePath })
          yield* Effect.promise(() => writeFile(input.filePath, "bad changed text\n"))
          const result = yield* LSPMutation.make({ lsp, enabled: true }).after([change(input.filePath)])
          expect(result?.files[0]).toMatchObject({
            filePath: input.filePath,
            state: "reported",
            source: "push",
            freshness: "current",
            version: before.version + 1,
            diagnostics: [{ message: "problem-version-2" }],
          })
          const count = input.events.filter((event) => event.method === "textDocument/diagnostic").length
          yield* Effect.promise(() => unlink(input.filePath))
          expect(
            (yield* LSPMutation.make({ lsp, enabled: true }).after([change(input.filePath, "deleted")]))?.files,
          ).toEqual([{ filePath: input.filePath, state: "closed" }])
          yield* Effect.promise(() => input.wait((event) => event.method === "textDocument/didClose"))
          expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
          expect(input.events.filter((event) => event.method === "textDocument/diagnostic")).toHaveLength(count)
        }),
      )
    } finally {
      await input.close()
    }
  })

  it("cancels an actual held diagnostic request on the helper deadline and keeps the connection usable", async () => {
    const input = await native("diag-pull-hold")
    try {
      await run(input, (lsp) =>
        Effect.gen(function* () {
          yield* lsp.query({ filePath: input.filePath, operation: "hover", line: 0, character: 0 })
          const pending = yield* LSPMutation.make({ lsp, enabled: true, timeout: 100 })
            .after([change(input.filePath)])
            .pipe(Effect.forkChild)
          yield* Effect.promise(() => input.wait((event) => event.type === "held" && event.id === -4))
          const exit = yield* Fiber.await(pending)
          expect(Exit.isSuccess(exit) && exit.value?.timedOut).toBe(true)
          yield* Effect.promise(() => input.wait((event) => event.method === "$/cancelRequest"))
          input.holds.get(-4)?.()
          yield* lsp.query({ filePath: input.filePath, operation: "hover", line: 0, character: 0 })
          expect(input.events.filter((event) => event.method === "textDocument/diagnostic")).toHaveLength(1)
          expect((yield* lsp.status())[0]?.status).toBe("connected")
        }),
      )
    } finally {
      await input.close()
    }
  })
})
