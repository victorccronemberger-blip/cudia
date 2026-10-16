import { describe, expect } from "bun:test"
import path from "path"
import { promises } from "node:fs"
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Stream } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { Config } from "@opencode-ai/core/config"
import { ConfigToolOutput } from "@opencode-ai/core/config/tool-output"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { TextPage } from "@opencode-ai/core/util/text-page"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const sessionID = SessionV2.ID.make("ses_tool_output_store")
const assistantMessageID = SessionMessage.ID.make("msg_tool_output_store")
const owner = { sessionID, assistantMessageID, toolCallID: "call-retained" }

const retained = (store: ToolOutputStore.Interface, text = "x".repeat(ToolOutputStore.MAX_BYTES + 1)) =>
  store.bound({ ...owner, output: { structured: {}, content: [{ type: "text", text }] } })

const readReason = <A>(effect: Effect.Effect<A, ToolOutputStore.ReadError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  )

const withStore = <A, E, R>(
  body: (input: { root: string; store: ToolOutputStore.Interface; fs: FSUtil.Interface }) => Effect.Effect<A, E, R>,
  config?: Config.Info,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const global = Global.layerWith({ data: tmp.path })
      const configured = config
        ? Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () => Effect.succeed([new Config.Document({ type: "document", info: config })]),
            }),
          )
        : Layer.empty

      const store = AppNodeBuilder.build(LayerNode.group([ToolOutputStore.node, FSUtil.node]), [
        [Global.node, global],
        [Config.node, configured],
      ])
      return Effect.gen(function* () {
        return yield* body({ root: tmp.path, store: yield* ToolOutputStore.Service, fs: yield* FSUtil.Service })
      }).pipe(Effect.provide(store))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

const it = testEffect(Layer.empty)

describe("ToolOutputStore", () => {
  it.live(
    "reports representative complete reconstruction cost without a machine-specific latency threshold",
    () =>
      withStore(({ store }) =>
        Effect.gen(function* () {
          const text = "0123456789abcdef".repeat(65_536)
          const result = yield* retained(store, text)
          const bytes = (yield* Effect.promise(() => promises.stat(result.outputPaths[0]!))).size
          const hash = TextPage.hash(text)
          const reconstructed: string[] = []
          const durations: number[] = []
          const started = performance.now()
          for (let offset = 0; offset < text.length; offset += TextPage.MAX_UNITS) {
            const pageStarted = performance.now()
            const snapshot = yield* store.page({
              ...owner,
              outputPaths: result.outputPaths,
              offset,
              limit: TextPage.MAX_UNITS,
            })
            durations.push(performance.now() - pageStarted)
            expect(snapshot.contentHash).toBe(hash)
            reconstructed.push(
              snapshot.text.slice(offset - snapshot.start, offset - snapshot.start + TextPage.MAX_UNITS),
            )
          }
          const elapsedMs = performance.now() - started
          const sorted = durations.toSorted((first, second) => first - second)
          expect(reconstructed.join("")).toBe(text)
          console.info(
            "tool-output-store reconstruction measurement",
            JSON.stringify({
              artifactBytes: bytes,
              unitsPerPage: TextPage.MAX_UNITS,
              pages: durations.length,
              elapsedMs: Math.round(elapsedMs * 100) / 100,
              medianPageMs: Math.round(sorted[Math.floor(sorted.length / 2)]! * 100) / 100,
              p95PageMs: Math.round(sorted[Math.floor(sorted.length * 0.95)]! * 100) / 100,
              estimatedBytesRead: bytes * durations.length,
            }),
          )
        }),
      ),
    30_000,
  )

  it.live("preserves interruption during a known-started streaming read and closes its scoped real file handle", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const result = yield* retained(store)
        const reading = yield* Deferred.make<Awaited<ReturnType<typeof promises.open>>>()
        const source = Stream.unwrap(
          Effect.gen(function* () {
            const handle = yield* Effect.acquireRelease(
              Effect.promise(() => promises.open(result.outputPaths[0]!, "r")),
              (opened) => Effect.promise(() => opened.close()),
            )
            return Stream.fromEffect(
              Effect.promise(async () => {
                const buffer = Buffer.alloc(64)
                const read = await handle.read(buffer, 0, buffer.length, 0)
                return buffer.subarray(0, read.bytesRead)
              }),
            ).pipe(
              Stream.concat(Stream.fromEffect(Deferred.succeed(reading, handle).pipe(Effect.andThen(Effect.never)))),
            )
          }),
        )
        const fiber = yield* TextPage.snapshot(source, { offset: 0, limit: 10, fatal: true }).pipe(Effect.forkChild)
        // The first file read has been consumed; the next read is deliberately gated.
        const handle = yield* Deferred.await(reading)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        if (Exit.isFailure(exit)) expect(Option.isNone(Cause.findErrorOption(exit.cause))).toBe(true)
        expect(
          yield* Effect.promise(() =>
            handle.stat().then(
              () => false,
              () => true,
            ),
          ),
        ).toBe(true)
      }),
    ),
  )

  it.live("preserves interruption through the actual retained-page API and allows subsequent artifact reads", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const result = yield* retained(store)
        // A sparse extension makes the real read long enough to request cancellation without allocating a huge string.
        yield* Effect.promise(() => promises.truncate(result.outputPaths[0]!, 64 * 1024 * 1024))
        const entered = yield* Deferred.make<void>()
        const fiber = yield* Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(store.page({ ...owner, outputPaths: result.outputPaths, offset: 0, limit: 10 })),
          Effect.forkChild,
        )
        yield* Deferred.await(entered)
        yield* Effect.sleep("5 millis")
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
        if (Exit.isFailure(exit)) expect(Option.isNone(Cause.findErrorOption(exit.cause))).toBe(true)
        // Store-private read ordering is intentionally unobserved here; the gated test proves the stream-phase boundary.
        yield* Effect.promise(() => promises.writeFile(result.outputPaths[0]!, "after interruption"))
        expect((yield* store.page({ ...owner, outputPaths: result.outputPaths, offset: 0, limit: 100 })).text).toBe(
          "after interruption",
        )
      }),
    ),
  )

  it.live("retains owner-bound UTF-8 text and reconstructs exact code units with a stable full-source hash", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const text = "\uFEFF" + "long line 😀 e\u0301\u0000\r\t".repeat(5_000) + "\nend"
        const result = yield* retained(store, text)
        expect((yield* Effect.promise(() => promises.readFile(result.outputPaths[0]!))).toString("utf8")).toBe(text)
        expect(path.basename(result.outputPaths[0]!)).toMatch(/^tool_[a-f0-9]{64}_[A-Za-z0-9]+$/)
        expect(result.output.content[0]?.type === "text" && result.output.content[0].text).toContain(
          `tool_result(${JSON.stringify({ messageID: assistantMessageID, callID: owner.toolCallID })})`,
        )
        const recovered: string[] = []
        for (let offset = 0; offset < text.length; offset += TextPage.MAX_UNITS) {
          const snapshot = yield* store.page({
            ...owner,
            outputPaths: result.outputPaths,
            offset,
            limit: TextPage.MAX_UNITS,
          })
          expect(snapshot.start).toBe(Math.max(0, offset - 1))
          expect(snapshot.totalLength).toBe(text.length)
          expect(snapshot.contentHash).toBe(TextPage.hash(text))
          recovered.push(snapshot.text.slice(offset - snapshot.start, offset - snapshot.start + TextPage.MAX_UNITS))
        }
        expect(recovered.join("")).toBe(text)
        const eof = yield* store.page({ ...owner, outputPaths: result.outputPaths, offset: text.length, limit: 1 })
        expect(eof.totalLength).toBe(text.length)
        expect(eof.text).toBe(text.slice(-1))
      }),
    ),
  )

  it.live("rejects retained references belonging to any different session, message, or call", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const result = yield* retained(store)
        for (const changed of [
          { sessionID: SessionV2.ID.make("ses_other") },
          { assistantMessageID: SessionMessage.ID.make("msg_other") },
          { toolCallID: "call-other" },
        ]) {
          expect(
            yield* readReason(
              store.page({ ...owner, ...changed, outputPaths: result.outputPaths, offset: 0, limit: 5 }),
            ),
          ).toBe("ownership")
        }
      }),
    ),
  )

  it.live("rejects legacy references explicitly and validates one absolute managed path", () =>
    withStore(({ root, store }) =>
      Effect.gen(function* () {
        const legacy = yield* store.bound({
          sessionID,
          toolCallID: "legacy",
          output: {
            structured: {},
            content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }],
          },
        })
        expect(yield* readReason(store.page({ ...owner, outputPaths: legacy.outputPaths, offset: 0, limit: 1 }))).toBe(
          "legacy",
        )
        const result = yield* retained(store)
        for (const outputPaths of [[], [...result.outputPaths, ...result.outputPaths]])
          expect(yield* readReason(store.page({ ...owner, outputPaths, offset: 0, limit: 1 }))).toBe("references")
        for (const file of [
          "relative-file",
          path.join(root, "outside"),
          path.join(root, "tool-output", "nested", "file"),
        ]) {
          const error = yield* store.page({ ...owner, outputPaths: [file], offset: 0, limit: 1 }).pipe(Effect.flip)
          expect(error.reason).toBe("path")
          expect(error.message).not.toContain(file)
        }
        for (const range of [
          { offset: -1, limit: 1 },
          { offset: 0, limit: 0 },
          { offset: 0, limit: TextPage.MAX_UNITS + 1 },
          { offset: 0.5, limit: 1 },
        ])
          expect(yield* readReason(store.page({ ...owner, outputPaths: result.outputPaths, ...range }))).toBe("range")
      }),
    ),
  )

  it.live("fails explicitly for missing and expired retained files before cleanup", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const expired = yield* retained(store)
        const date = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
        yield* fs.utimes(expired.outputPaths[0]!, date, date)
        expect(yield* readReason(store.page({ ...owner, outputPaths: expired.outputPaths, offset: 0, limit: 1 }))).toBe(
          "expired",
        )
        const missing = yield* retained(store)
        yield* fs.remove(missing.outputPaths[0]!)
        expect(yield* readReason(store.page({ ...owner, outputPaths: missing.outputPaths, offset: 0, limit: 1 }))).toBe(
          "missing",
        )
      }),
    ),
  )

  it.live("rejects malformed UTF-8 instead of silently substituting characters", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const result = yield* retained(store)
        yield* Effect.promise(() => promises.writeFile(result.outputPaths[0]!, Buffer.from([0x61, 0xc3, 0x28])))
        expect(yield* readReason(store.page({ ...owner, outputPaths: result.outputPaths, offset: 0, limit: 3 }))).toBe(
          "encoding",
        )
      }),
    ),
  )

  it.live("rejects mutation detected while streaming a retained artifact", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const result = yield* retained(store, "large source 😀\n".repeat(500_000))
        const file = result.outputPaths[0]!
        const updates: Promise<void>[] = []
        const exit = yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            setInterval(() => {
              const date = new Date()
              updates.push(promises.utimes(file, date, date))
            }, 1),
          ),
          () => store.page({ ...owner, outputPaths: result.outputPaths, offset: 0, limit: 20 }).pipe(Effect.exit),
          (timer) =>
            Effect.promise(async () => {
              clearInterval(timer)
              await Promise.all(updates)
            }),
        )
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))?.reason).toBe("changed")
      }),
    ),
  )

  it.live("rejects nonregular files and symlink escapes", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const result = yield* retained(store)
        const file = result.outputPaths[0]!
        yield* fs.remove(file)
        yield* fs.ensureDir(file)
        expect(yield* readReason(store.page({ ...owner, outputPaths: [file], offset: 0, limit: 1 }))).toBe("path")
        yield* Effect.promise(() => promises.rmdir(file))
        const outside = path.join(root, "outside")
        yield* fs.ensureDir(outside)
        // Windows junction creation requires no developer-mode symlink privileges.
        yield* Effect.promise(() => promises.symlink(outside, file, "junction"))
        expect(yield* readReason(store.page({ ...owner, outputPaths: [file], offset: 0, limit: 1 }))).toBe("path")
        yield* Effect.promise(() => promises.unlink(file))
        yield* Effect.promise(() => promises.rmdir(path.join(root, "tool-output")))
        yield* Effect.promise(() => promises.symlink(outside, path.join(root, "tool-output"), "junction"))
        expect(yield* readReason(store.page({ ...owner, outputPaths: [file], offset: 0, limit: 1 }))).toBe("path")
      }),
    ),
  )

  it.live("preserves lone surrogates with tagged UTF-16 retention without changing small output", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const small = { structured: {}, content: [{ type: "text" as const, text: "\ud800" }] }
        expect((yield* store.bound({ ...owner, output: small })).output).toEqual(small)
        const text = "x".repeat(ToolOutputStore.MAX_BYTES) + "\ud800\u0000\udfff😀"
        const result = yield* retained(store, text)
        expect(result.outputPaths[0]).toEndWith(".utf16le")
        const snapshot = yield* store.page({
          ...owner,
          outputPaths: result.outputPaths,
          offset: ToolOutputStore.MAX_BYTES,
          limit: 10,
        })
        expect(snapshot.text.slice(ToolOutputStore.MAX_BYTES - snapshot.start)).toBe("\ud800\u0000\udfff😀")
        expect(snapshot.contentHash).toBe(TextPage.hash(text))
        expect(snapshot.totalLength).toBe(text.length)
        yield* Effect.promise(() => promises.appendFile(result.outputPaths[0]!, Buffer.from([0x61])))
        expect(yield* readReason(store.page({ ...owner, outputPaths: result.outputPaths, offset: 0, limit: 3 }))).toBe(
          "encoding",
        )
      }),
    ),
  )

  it.live("keeps tiny previews within configured limits while retaining recoverable owner-bound output", () =>
    withStore(
      ({ store }) =>
        Effect.gen(function* () {
          const result = yield* retained(store, "😀".repeat(50))
          expect(result.outputPaths).toHaveLength(1)
          expect(
            result.output.content[0]?.type === "text" && Buffer.byteLength(result.output.content[0].text),
          ).toBeLessThanOrEqual(8)
          expect(
            (yield* store.page({ ...owner, outputPaths: result.outputPaths, offset: 0, limit: 100 })).totalLength,
          ).toBe(100)
        }),
      new Config.Info({ tool_output: new ConfigToolOutput.Info({ max_lines: 1, max_bytes: 8 }) }),
    ),
  )

  it.live("bounds the provider-facing text channel with one managed file", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const first = "HEAD-" + "x".repeat(30_000)
        const second = "y".repeat(30_000) + "-TAIL"
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-aggregate",
          output: {
            structured: { kind: "report" },
            content: [
              { type: "text", text: first },
              { type: "text", text: second },
            ],
          },
        })
        expect(result.output.structured).toEqual({ kind: "report" })
        expect(result.outputPaths).toHaveLength(1)
        expect(yield* fs.readFileString(result.outputPaths[0])).toBe(first + second)
        if (result.output.content[0]?.type !== "text") throw new Error("expected text preview")
        expect(Buffer.byteLength(result.output.content[0].text)).toBeLessThanOrEqual(ToolOutputStore.MAX_BYTES)
      }),
    ),
  )

  it.live("uses bounded text for oversized structured-only output", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const structured = { text: "x".repeat(ToolOutputStore.MAX_BYTES) }
        const result = yield* store.bound({ sessionID, toolCallID: "call-json", output: { structured, content: [] } })
        expect(result.output.structured).toEqual(structured)
        expect(result.outputPaths).toHaveLength(1)
        expect(JSON.parse(yield* fs.readFileString(result.outputPaths[0]))).toEqual(structured)
        expect(result.output.content).toHaveLength(1)
      }),
    ),
  )

  it.live("preserves native media and structured metadata without applying a settlement media limit", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const data = "a".repeat(6 * 1024 * 1024)
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-file",
          output: {
            structured: { caption: "pixel" },
            content: [{ type: "file", uri: `data:image/png;base64,${data}`, mime: "image/png", name: "pixel.png" }],
          },
        })
        expect(result.outputPaths).toEqual([])
        expect(result.output.structured).toEqual({ caption: "pixel" })
        expect(result.output.content).toHaveLength(1)
        expect(result.output.content[0]).toEqual({
          type: "file",
          uri: `data:image/png;base64,${data}`,
          mime: "image/png",
          name: "pixel.png",
        })
      }),
    ),
  )

  it.live("preserves structured metadata and native media when bounding text", () =>
    withStore(({ store, fs }) =>
      Effect.gen(function* () {
        const text = "x".repeat(ToolOutputStore.MAX_BYTES + 1)
        const media = {
          type: "file" as const,
          uri: "data:image/png;base64,aGVsbG8=",
          mime: "image/png",
          name: "pixel.png",
        }
        const result = yield* store.bound({
          sessionID,
          toolCallID: "call-text-and-media",
          output: { structured: { caption: "pixel" }, content: [{ type: "text", text }, media] },
        })

        expect(result.output.structured).toEqual({ caption: "pixel" })
        expect(result.output.content[1]).toEqual(media)
        expect(yield* fs.readFileString(result.outputPaths[0])).toBe(text)
      }),
    ),
  )

  it.live("does not double-count structured data duplicated in projected text", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const text = "x".repeat(30_000)
        const output = { structured: { output: text }, content: [{ type: "text" as const, text }] }
        expect(yield* store.bound({ sessionID, toolCallID: "call-duplicated", output })).toEqual({
          output,
          outputPaths: [],
        })
      }),
    ),
  )

  it.live("fails oversized settlement when complete retention cannot be written", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        yield* fs.writeFileString(path.join(root, "tool-output"), "not a directory")
        const exit = yield* store
          .bound({
            sessionID,
            toolCallID: "call-lossy",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit))
          expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag).toBe("ToolOutputStore.StorageError")
      }),
    ),
  )

  it.live("does not encode ignored structured metadata when projected content exists", () =>
    withStore(({ store }) =>
      Effect.gen(function* () {
        const output = { structured: { value: 1n }, content: [{ type: "text" as const, text: "readable text" }] }
        expect(yield* store.bound({ sessionID, toolCallID: "call-unencodable", output })).toEqual({
          output,
          outputPaths: [],
        })
      }),
    ),
  )

  it.live("preserves interruption while retaining complete output", () =>
    Effect.gen(function* () {
      const root = yield* Effect.promise(() => tmpdir())
      const blockedFilesystem = Layer.effect(
        FSUtil.Service,
        Effect.gen(function* () {
          const fs = yield* FSUtil.Service
          return FSUtil.Service.of({
            ...fs,
            ensureDir: () => Effect.void,
            writeFileString: () => Effect.never,
          })
        }),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const store = AppNodeBuilder.build(ToolOutputStore.nodeWithoutConfig, [
        [Global.node, Global.layerWith({ data: root.path })],
        [FSUtil.node, blockedFilesystem],
      ])
      const exit = yield* Effect.gen(function* () {
        const service = yield* ToolOutputStore.Service
        const fiber = yield* service
          .bound({
            sessionID,
            toolCallID: "call-interrupted",
            output: { structured: {}, content: [{ type: "text", text: "x".repeat(ToolOutputStore.MAX_BYTES + 1) }] },
          })
          .pipe(Effect.forkChild)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }).pipe(Effect.provide(store))
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      yield* Effect.promise(() => root[Symbol.asyncDispose]())
    }),
  )

  it.live("honors configured limits", () =>
    withStore(
      ({ store }) =>
        Effect.gen(function* () {
          expect(yield* store.limits()).toEqual({ maxLines: 2, maxBytes: 1_000 })
          const result = yield* store.bound({
            sessionID,
            toolCallID: "call-config",
            output: { structured: {}, content: [{ type: "text", text: "one\ntwo\nthree" }] },
          })
          expect(result.outputPaths).toHaveLength(1)
        }),
      new Config.Info({ tool_output: new ConfigToolOutput.Info({ max_lines: 2, max_bytes: 1_000 }) }),
    ),
  )

  it.live("cleans expired managed files and preserves unrelated files", () =>
    withStore(({ root, store, fs }) =>
      Effect.gen(function* () {
        const old = path.join(root, "tool-output", "tool_old")
        const recent = path.join(root, "tool-output", "tool_recent")
        const unrelated = path.join(root, "tool-output", "keep.txt")
        yield* fs.ensureDir(path.join(root, "tool-output"))
        yield* fs.writeFileString(old, "old")
        yield* fs.writeFileString(recent, "recent")
        yield* fs.writeFileString(unrelated, "keep")
        const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000)
        yield* fs.utimes(old, expired, expired)
        yield* store.cleanup()
        expect(yield* fs.exists(old)).toBe(false)
        expect(yield* fs.exists(recent)).toBe(true)
        expect(yield* fs.exists(unrelated)).toBe(true)
      }),
    ),
  )
})
