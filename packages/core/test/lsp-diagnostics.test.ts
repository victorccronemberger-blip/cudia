import { describe, expect, it } from "bun:test"
import { Effect, Exit, Fiber, Layer } from "effect"
import { mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { ConfigLSP } from "../src/config/lsp"
import { FSUtil } from "../src/fs-util"
import { LayerNode } from "../src/effect/layer-node"
import { LSPV2 } from "../src/lsp"
import { Service, node } from "../src/process"
import { EventV2 } from "../src/event"
import { LspEvent } from "@opencode-ai/schema/lsp-event"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { Config } from "../src/config"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { WorkspaceV2 } from "../src/workspace"
import { location } from "./fixture/location"
import { LSPDiagnostics } from "../src/lsp/diagnostics"

const layer = Layer.merge(LayerNode.compile(FSUtil.node), LayerNode.compile(node))
const fixture = path.join(import.meta.dir, "lsp-fixtures", "stdio.js")
type Event = { readonly type: string; readonly method?: string; readonly id?: number; readonly params?: unknown }
async function setup(mode: string, name = "file.ts") {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "cudia-lsp-diagnostics-")))
  const filePath = path.join(directory, name)
  await writeFile(filePath, "bad text\r\n")
  const events: Event[] = []
  const watchers = new Set<() => void>()
  const holds = new Map<number, () => void>()
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const value = (await request.json()) as Event & { id: number }
      if (new URL(request.url).pathname === "/hold")
        return new Promise<Response>((resolve) => {
          holds.set(value.id, () => {
            holds.delete(value.id)
            resolve(new Response("release"))
          })
          events.push({ type: "held", id: value.id })
          watchers.forEach((notify) => notify())
        })
      events.push(value)
      watchers.forEach((notify) => notify())
      return new Response("ok")
    },
  })
  const wait = (predicate: (event: Event) => boolean) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        watchers.delete(check)
        reject(new Error("Diagnostic fixture barrier timed out"))
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
  return {
    directory,
    filePath,
    events,
    holds,
    wait,
    configuration: {
      fixture: new ConfigLSP.Server({
        command: [process.execPath, fixture],
        extensions: ["ts"],
        env: { LSP_MODE: mode, LSP_CONTROL: control.url.href.replace(/\/$/, "") },
      }),
    },
    async close() {
      holds.forEach((release) => release())
      await control.stop(true)
      await rm(directory, { recursive: true, force: true })
    },
  }
}
function run<A, E>(
  input: Awaited<ReturnType<typeof setup>>,
  body: (runtime: LSPV2.Interface) => Effect.Effect<A, E>,
  options?: {
    readonly onChange?: Effect.Effect<void>
    readonly request?: number
    readonly fs?: (fs: FSUtil.Interface) => FSUtil.Interface
  },
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FSUtil.Service
        const process = yield* Service
        const runtime = yield* LSPV2.make({
          directory: input.directory,
          configuration: input.configuration,
          fs: options?.fs?.(fs) ?? fs,
          process,
          onChange: options?.onChange,
          timeout: { startup: 3000, request: options?.request ?? 300 },
        })
        return yield* body(runtime)
      }),
    ).pipe(Effect.provide(layer)),
  )
}

describe("native LSP diagnostics", () => {
  it("projects only standard range fields and bounds item and byte retention", () => {
    const range = {
      start: { line: 0, character: 0, uri: "file:///private.ts" },
      end: { line: 0, character: 1 },
      data: "private",
    }
    const projected = LSPDiagnostics.decode([{ range, message: "problem", data: "secret" }])
    expect(projected?.diagnostics[0]?.range).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    })
    expect(JSON.stringify(projected)).not.toContain("private")
    expect(JSON.stringify(projected)).not.toContain("secret")
    expect(LSPDiagnostics.decode([{ range, message: "problem", severity: "1" }])).toBeUndefined()
    const count = LSPDiagnostics.decode(Array.from({ length: 1000 }, () => ({ range, message: "problem" })))
    expect(count?.diagnostics).toHaveLength(256)
    expect(count?.omitted).toBe(744)
    const bytes = LSPDiagnostics.decode(Array.from({ length: 10 }, () => ({ range, message: "x".repeat(100_000) })))
    expect(bytes!.bytes).toBeLessThanOrEqual(LSPDiagnostics.MAX_REPORT_BYTES)
    expect(bytes!.omitted).toBeGreaterThan(0)
  })
  it("reports cold status without reading, resolving executables or starting a process", async () => {
    const input = await setup("diag-push")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          expect(yield* runtime.status()).toEqual([
            { id: "fixture", name: "fixture", root: input.directory, status: "not_started", diagnosticMode: "none" },
          ])
          yield* runtime.forget({ filePath: input.filePath, kind: "deleted" })
          yield* runtime.didClose({ filePath: input.filePath })
          expect(input.events).toHaveLength(0)
        }),
      )
    } finally {
      await input.close()
    }
  })

  it("accepts exact-version push reports, projects negotiated fields and replaces errors with an empty clear", async () => {
    const input = await setup("diag-push")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          const first = yield* runtime.diagnostics({ filePath: input.filePath })
          expect(first).toMatchObject({ freshness: "current", source: "push", version: 1, omitted: 3 })
          expect(first.diagnostics).toHaveLength(1)
          expect(JSON.stringify(first)).not.toContain("outside.ts")
          expect(JSON.stringify(first)).not.toContain("ignored")
          yield* Effect.promise(() => writeFile(input.filePath, "fixed text\r\n"))
          yield* runtime.forget({ filePath: input.filePath, kind: "changed" })
          const clear = yield* runtime.diagnostics({ filePath: input.filePath })
          expect(clear).toMatchObject({ freshness: "current", source: "push", version: 2, diagnostics: [] })
          expect(clear.generation).toBeGreaterThan(first.generation)
          expect((yield* runtime.status())[0]).toMatchObject({ status: "connected", diagnosticMode: "push" })
        }),
      )
    } finally {
      await input.close()
    }
  })

  it("matches equivalent encoded file URIs and Windows drive spellings without filesystem normalization", async () => {
    const input = await setup("diag-uri-alias", "one file [x] café.ts")
    const accessed: string[] = []
    try {
      await run(
        input,
        (runtime) =>
          Effect.gen(function* () {
            const report = yield* runtime.diagnostics({ filePath: input.filePath })
            expect(report).toMatchObject({ source: "push", freshness: "current", version: 1 })
            expect(report.diagnostics).toHaveLength(1)
            yield* Effect.promise(() => input.wait((event) => event.type === "diagnostic-sent"))
            const published = input.events.find((event) => event.type === "diagnostic-sent")?.params as { uri: string }
            const publishedUri = published.uri
            expect(publishedUri).not.toBe(pathToFileURL(input.filePath).href)
            expect(publishedUri).toContain("/%6fne%20file")
            if (process.platform === "win32") expect(publishedUri).toMatch(/^file:\/\/\/[a-z]%3A\//)
            expect(accessed.length).toBeGreaterThan(0)
            expect(accessed.every((target) => target === input.directory || target === input.filePath)).toBe(true)
          }),
        {
          fs: (fs) => ({
            ...fs,
            realPath: (target) => Effect.sync(() => accessed.push(target)).pipe(Effect.andThen(fs.realPath(target))),
            stat: (target) => Effect.sync(() => accessed.push(target)).pipe(Effect.andThen(fs.stat(target))),
            open: (target, options) =>
              Effect.sync(() => accessed.push(target)).pipe(Effect.andThen(fs.open(target, options))),
          }),
        },
      )
    } finally {
      await input.close()
    }
  })

  for (const value of ["malformed", "nonfile", "separator", "unknown", "query", "fragment"]) {
    it(`ignores ${value} diagnostic URIs without inspecting their targets`, async () => {
      const input = await setup("diag-push")
      const uri = pathToFileURL(input.filePath).href
      const published =
        value === "malformed"
          ? "not a URI"
          : value === "nonfile"
            ? uri.replace(/^file:/, "git:")
            : value === "separator"
              ? uri.replace(/file\.ts$/, "nested%2Ffile.ts")
              : value === "unknown"
                ? pathToFileURL(path.join(input.directory, "unadmitted.ts")).href
                : `${uri}${value === "query" ? "?version=1" : "#fragment"}`
      input.configuration.fixture = new ConfigLSP.Server({
        ...input.configuration.fixture,
        env: { ...input.configuration.fixture.env, LSP_DIAGNOSTIC_URI: published },
      })
      try {
        await run(
          input,
          (runtime) =>
            Effect.gen(function* () {
              expect(yield* runtime.diagnostics({ filePath: input.filePath })).toMatchObject({
                source: "none",
                freshness: "pending",
                diagnostics: [],
              })
              expect((yield* runtime.status())[0]?.diagnosticMode).toBe("none")
            }),
          {
            fs: (fs) => ({
              ...fs,
              realPath: (target) => {
                expect([input.directory, input.filePath]).toContain(target)
                return fs.realPath(target)
              },
              stat: (target) => {
                expect(target).toBe(input.filePath)
                return fs.stat(target)
              },
              open: (target, options) => {
                expect(target).toBe(input.filePath)
                return fs.open(target, options)
              },
            }),
          },
        )
      } finally {
        await input.close()
      }
    })
  }

  it("supports full and unchanged pull reports only with the matching live result ID", async () => {
    const input = await setup("diag-pull")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          const first = yield* runtime.diagnostics({ filePath: input.filePath })
          const second = yield* runtime.diagnostics({ filePath: input.filePath })
          expect(first).toMatchObject({ freshness: "current", source: "pull", version: 1 })
          expect(second.diagnostics).toEqual(first.diagnostics)
          expect(input.events.filter((event) => event.method === "textDocument/diagnostic")).toHaveLength(2)
          expect((yield* runtime.status())[0]).toMatchObject({ diagnosticMode: "pull" })
          yield* Effect.promise(() => writeFile(input.filePath, "new bad text\n"))
          yield* runtime.forget({ filePath: input.filePath, kind: "changed" })
          expect((yield* runtime.diagnostics({ filePath: input.filePath })).version).toBe(2)
          const last = input.events.filter((event) => event.method === "textDocument/diagnostic").at(-1)
          expect(last?.params).not.toHaveProperty("previousResultId")
        }),
      )
    } finally {
      await input.close()
    }
  })

  for (const mode of ["diag-unversioned", "diag-stale", "diag-none"]) {
    it(`does not label ${mode} as a current healthy report`, async () => {
      const input = await setup(mode)
      try {
        await run(input, (runtime) =>
          Effect.gen(function* () {
            const result = yield* runtime.diagnostics({ filePath: input.filePath })
            expect(result.freshness).toBe(mode === "diag-unversioned" ? "unversioned" : "pending")
            expect(result.source).toBe(mode === "diag-unversioned" ? "push" : "none")
          }),
        )
      } finally {
        await input.close()
      }
    })
  }

  it("checks the actual disk hash after a pull response even when no mutation notification was received", async () => {
    const input = await setup("diag-pull-hold")
    try {
      await run(
        input,
        (runtime) =>
          Effect.gen(function* () {
            const pending = yield* runtime
              .diagnostics({ filePath: input.filePath })
              .pipe(Effect.result, Effect.forkChild)
            yield* Effect.promise(() => input.wait((event) => event.type === "held" && event.id === -4))
            yield* Effect.promise(() => writeFile(input.filePath, "different bad text\n"))
            input.holds.get(-4)!()
            const exit = yield* Fiber.await(pending)
            expect(Exit.isSuccess(exit) && exit.value._tag === "Failure" && exit.value.failure.kind).toBe("document")
          }),
        { request: 2000 },
      )
    } finally {
      await input.close()
    }
  })

  it("ignores a late push after caller cancellation and preserves the healthy connection", async () => {
    const input = await setup("diag-push-hold")
    try {
      await run(
        input,
        (runtime) =>
          Effect.gen(function* () {
            const pending = yield* runtime.diagnostics({ filePath: input.filePath }).pipe(Effect.forkChild)
            yield* Effect.promise(() => input.wait((event) => event.type === "held" && event.id === -3))
            yield* Fiber.interrupt(pending)
            input.holds.get(-3)!()
            yield* Effect.promise(() => input.wait((event) => event.type === "diagnostic-sent"))
            yield* runtime.query({ operation: "hover", filePath: input.filePath, line: 0, character: 0 })
            expect((yield* runtime.status())[0]).toMatchObject({ status: "connected", diagnosticMode: "none" })
            expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
          }),
        { request: 2000 },
      )
    } finally {
      await input.close()
    }
  })

  it("checks the actual disk hash after a versioned push before returning current", async () => {
    const input = await setup("diag-push-hold")
    try {
      await run(
        input,
        (runtime) =>
          Effect.gen(function* () {
            const pending = yield* runtime
              .diagnostics({ filePath: input.filePath })
              .pipe(Effect.result, Effect.forkChild)
            yield* Effect.promise(() => input.wait((event) => event.type === "held" && event.id === -3))
            yield* Effect.promise(() => writeFile(input.filePath, "changed bad text\n"))
            input.holds.get(-3)!()
            const exit = yield* Fiber.await(pending)
            expect(Exit.isSuccess(exit) && exit.value._tag === "Failure" && exit.value.failure.kind).toBe("document")
          }),
        { request: 2000 },
      )
    } finally {
      await input.close()
    }
  })

  it("forgets an in-flight pull locally and rejects its late response without restarting the server", async () => {
    const input = await setup("diag-pull-hold")
    try {
      await run(
        input,
        (runtime) =>
          Effect.gen(function* () {
            const pending = yield* runtime
              .diagnostics({ filePath: input.filePath })
              .pipe(Effect.result, Effect.forkChild)
            yield* Effect.promise(() => input.wait((event) => event.type === "held" && event.id === -4))
            yield* runtime.forget({ filePath: input.filePath, kind: "changed" })
            input.holds.get(-4)!()
            const exit = yield* Fiber.await(pending)
            expect(Exit.isSuccess(exit) && exit.value._tag === "Failure" && exit.value.failure.kind).toBe("request")
            expect((yield* runtime.status())[0]?.status).toBe("connected")
            expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
          }),
        { request: 2000 },
      )
    } finally {
      await input.close()
    }
  })

  it("locally forgets deletes, closes only the existing document, and never resets versions on reopen", async () => {
    const input = await setup("diag-push")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          const first = yield* runtime.diagnostics({ filePath: input.filePath })
          yield* Effect.promise(() => unlink(input.filePath))
          yield* runtime.forget({ filePath: input.filePath, kind: "deleted" })
          yield* runtime.didClose({ filePath: input.filePath })
          yield* Effect.promise(() => input.wait((event) => event.method === "textDocument/didClose"))
          yield* Effect.promise(() => writeFile(input.filePath, "bad recreated\n"))
          const second = yield* runtime.diagnostics({ filePath: input.filePath })
          expect(second.version).toBeGreaterThan(first.version)
          expect(second.generation).toBeGreaterThan(first.generation)
          expect(second.diagnostics[0]?.message).toBe(`problem-version-${second.version}`)
          expect(input.events.filter((event) => event.method === "initialize")).toHaveLength(1)
        }),
      )
    } finally {
      await input.close()
    }
  })

  it("bounds push bursts and coalesces metadata invalidations into a scope-owned callback", async () => {
    const input = await setup("diag-push-burst")
    let updates = 0
    let published: (() => void) | undefined
    const changed = new Promise<void>((resolve) => {
      published = resolve
    })
    try {
      await run(
        input,
        (runtime) =>
          Effect.gen(function* () {
            const report = yield* runtime.diagnostics({ filePath: input.filePath })
            expect(report.diagnostics).toHaveLength(256)
            expect(report.omitted).toBeGreaterThanOrEqual(744)
            yield* Effect.promise(() => changed)
            expect(updates).toBeLessThan(10)
            expect((yield* runtime.status())[0]).toMatchObject({ diagnosticMode: "push" })
            const next = path.join(input.directory, "next.ts")
            yield* Effect.promise(() => writeFile(next, "bad next text\n"))
            // The preceding thousand unknown URIs must not consume admitted-document slots.
            expect((yield* runtime.diagnostics({ filePath: next })).diagnostics).toHaveLength(256)
          }),
        {
          onChange: Effect.sync(() => {
            updates++
            published?.()
          }),
          request: 1000,
        },
      )
    } finally {
      await input.close()
    }
  })

  it("accepts rotating unchanged result IDs and rejects unchanged without a prior valid report", async () => {
    for (const mode of ["diag-pull-rotate", "diag-pull-invalid-unchanged"]) {
      const input = await setup(mode)
      try {
        await run(input, (runtime) =>
          Effect.gen(function* () {
            if (mode === "diag-pull-invalid-unchanged") {
              const result = yield* Effect.result(runtime.diagnostics({ filePath: input.filePath }))
              expect(result._tag === "Failure" && result.failure.kind).toBe("protocol")
              return
            }
            for (let index = 0; index < 3; index++) {
              const result = yield* runtime.diagnostics({ filePath: input.filePath })
              expect(result).toMatchObject({ freshness: "current", source: "pull", version: 1 })
            }
            const calls = input.events.filter((event) => event.method === "textDocument/diagnostic")
            expect(calls[1]?.params).toMatchObject({ previousResultId: "rotated-1" })
            expect(calls[2]?.params).toMatchObject({ previousResultId: "rotated-2" })
          }),
        )
      } finally {
        await input.close()
      }
    }
  })

  it("returns pending after a bounded pull timeout and preserves the connection", async () => {
    const input = await setup("diag-pull-timeout")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          expect(yield* runtime.diagnostics({ filePath: input.filePath })).toMatchObject({
            freshness: "pending",
            source: "none",
          })
          yield* runtime.query({ filePath: input.filePath, operation: "hover", line: 0, character: 0 })
          expect((yield* runtime.status())[0]?.status).toBe("connected")
        }),
      )
    } finally {
      await input.close()
    }
  })

  it("never returns the previous cached diagnostic as current after a physical write before the helper runs", async () => {
    const input = await setup("diag-cached-hold")
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          const cached = yield* runtime.diagnostics({ filePath: input.filePath })
          expect(cached.freshness).toBe("current")
          yield* Effect.promise(() => writeFile(input.filePath, "changed bad text\n"))
          // Deliberately omit forget, representing interruption immediately after commit.
          const refreshed = yield* runtime.diagnostics({ filePath: input.filePath })
          expect(refreshed).toMatchObject({ freshness: "pending", source: "none", diagnostics: [] })
          expect(refreshed.version).toBeGreaterThan(cached.version)
          expect(refreshed.generation).toBeGreaterThan(cached.generation)
          input.holds.get(-3)?.()
        }),
      )
    } finally {
      await input.close()
    }
  })

  it("reveals missing status only after an authorized executable lookup and omits configuration secrets", async () => {
    const input = await setup("diag-push")
    input.configuration.fixture = new ConfigLSP.Server({
      command: ["cudia-lsp-binary-not-present-46839"],
      extensions: ["ts"],
      env: { PRIVATE_TOKEN: "secret-value" },
    })
    try {
      await run(input, (runtime) =>
        Effect.gen(function* () {
          expect((yield* runtime.status())[0]?.status).toBe("not_started")
          const result = yield* Effect.result(runtime.diagnostics({ filePath: input.filePath }))
          expect(result._tag === "Failure" && result.failure.kind).toBe("unavailable")
          const statuses = yield* runtime.status()
          expect(statuses[0]).toMatchObject({ status: "missing", failure: "unavailable" })
          expect(JSON.stringify(statuses)).not.toContain("secret-value")
          expect(JSON.stringify(statuses)).not.toContain("cudia-lsp-binary")
          expect(input.events).toHaveLength(0)
        }),
      )
    } finally {
      await input.close()
    }
  })

  it("publishes coalesced lsp.updated events with the construction Location even under another ambient Location", async () => {
    const input = await setup("diag-push")
    const ref = {
      directory: AbsolutePath.make(input.directory),
      workspaceID: WorkspaceV2.ID.make("wrk_diagnostics_location"),
    }
    const layers = AppNodeBuilder.build(LayerNode.group([LSPV2.node, EventV2.node]), [
      [Location.node, Layer.succeed(Location.Service, Location.Service.of(location(ref)))],
      [
        Config.node,
        Layer.succeed(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Document({ type: "document", info: new Config.Info({ lsp: input.configuration }) }),
              ]),
          }),
        ),
      ],
    ])
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const runtime = yield* LSPV2.Service
            const events = yield* EventV2.Service
            let complete: ((value: EventV2.Payload) => void) | undefined
            const next = new Promise<EventV2.Payload>((resolve) => {
              complete = resolve
            })
            yield* Effect.acquireRelease(
              events.listen((event) =>
                Effect.sync(() => {
                  if (event.type === LspEvent.Updated.type) complete?.(event)
                }),
              ),
              (unsubscribe) => unsubscribe,
            )
            yield* runtime
              .diagnostics({ filePath: input.filePath })
              .pipe(
                Effect.provideService(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(path.join(input.directory, "other")) })),
                ),
              )
            const event = yield* Effect.promise(() => next)
            expect(event.location).toEqual(ref)
          }),
        ).pipe(Effect.provide(layers)),
      )
    } finally {
      await input.close()
    }
  })
})
