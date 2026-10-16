export * as ToolOutputStore from "./tool-output-store"

import path from "path"
import { createHash } from "node:crypto"
import { constants, promises } from "node:fs"
import { Context, Duration, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import { Config } from "./config"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { makeGlobalNode, makeLocationNode } from "./effect/app-node"
import { SessionSchema } from "./session/schema"
import { SessionMessage } from "./session/message"
import { Identifier } from "./util/identifier"
import { TextPage } from "./util/text-page"
import type { ToolOutput } from "@opencode-ai/llm"

export const MAX_LINES = 2_000
export const MAX_BYTES = 50 * 1024
export const RETENTION = Duration.days(7)

export const MANAGED_DIRECTORY = "tool-output"

export interface BoundInput {
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID?: SessionMessage.ID
  readonly toolCallID: string
  readonly output: ToolOutput
}

export interface BoundResult {
  readonly output: ToolOutput
  readonly outputPaths: ReadonlyArray<string>
}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("ToolOutputStore.StorageError", {
  operation: Schema.Literals(["encode", "write"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    const detail = this.cause instanceof Error ? this.cause.message : String(this.cause)
    return `Failed to ${this.operation} tool output${detail ? `: ${detail}` : ""}`
  }
}

export type Error = StorageError

export interface PageInput {
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  readonly outputPaths: ReadonlyArray<string>
  readonly offset: number
  readonly limit: number
}

export class ReadError extends Schema.TaggedErrorClass<ReadError>()("ToolOutputStore.ReadError", {
  reason: Schema.Literals([
    "references",
    "range",
    "path",
    "legacy",
    "ownership",
    "missing",
    "expired",
    "changed",
    "encoding",
    "io",
  ]),
}) {
  override get message() {
    return `Retained tool output is unavailable (${this.reason})`
  }
}

export interface Interface {
  readonly limits: () => Effect.Effect<{ readonly maxLines: number; readonly maxBytes: number }>
  readonly bound: (input: BoundInput) => Effect.Effect<BoundResult, Error>
  readonly page: (input: PageInput) => Effect.Effect<
    {
      readonly text: string
      readonly start: number
      readonly totalLength: number
      readonly contentHash: string
    },
    ReadError
  >
  readonly cleanup: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/ToolOutputStore") {}

const takePrefix = (input: string, maximumBytes: number) => {
  let bytes = 0
  let content = ""
  for (const char of input) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content += char
    bytes += size
  }
  return content
}

const takeSuffix = (input: string, maximumBytes: number) => {
  let bytes = 0
  const content: string[] = []
  for (const char of Array.from(input).toReversed()) {
    const size = Buffer.byteLength(char, "utf-8")
    if (bytes + size > maximumBytes) break
    content.unshift(char)
    bytes += size
  }
  return content.join("")
}

const preview = (text: string, maxLines: number, maxBytes: number) => {
  const lines = text.split("\n")
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = Math.floor(maxLines / 2)
  const sampled =
    lines.length <= maxLines
      ? text
      : [
          lines.slice(0, headLines).join("\n"),
          ...(tailLines > 0 ? [lines.slice(lines.length - tailLines).join("\n")] : []),
        ].join("\n")
  if (Buffer.byteLength(sampled, "utf-8") <= maxBytes) {
    return lines.length <= maxLines
      ? { head: sampled, tail: "" }
      : {
          head: lines.slice(0, headLines).join("\n"),
          tail: tailLines > 0 ? lines.slice(lines.length - tailLines).join("\n") : "",
        }
  }
  const headBytes = Math.ceil(maxBytes / 2)
  const tailBytes = Math.floor(maxBytes / 2)
  return { head: takePrefix(sampled, headBytes), tail: takeSuffix(sampled, tailBytes) }
}

const boundedPreview = (text: string, marker: string, maxLines: number, maxBytes: number) => {
  const markerOnly = takePrefix(marker, maxBytes).split("\n").slice(0, maxLines).join("\n")
  const markerBytes = Buffer.byteLength(marker, "utf-8")
  if (maxLines <= 4 || maxBytes <= markerBytes + 4) return markerOnly
  const bounded = preview(text, maxLines - 4, maxBytes - markerBytes - 4)
  return bounded.tail ? `${bounded.head}\n\n${marker}\n\n${bounded.tail}` : `${bounded.head}\n\n${marker}`
}

const lineCount = (text: string) => {
  let count = 1
  for (const char of text) if (char === "\n") count++
  return count
}

const ownership = (input: { sessionID: SessionSchema.ID; assistantMessageID: SessionMessage.ID; toolCallID: string }) =>
  createHash("sha256")
    .update(JSON.stringify([input.sessionID, input.assistantMessageID, input.toolCallID]))
    .digest("hex")

const readFailure = (cause: unknown) =>
  cause instanceof ReadError
    ? cause
    : new ReadError({
        reason:
          typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT" ? "missing" : "io",
      })

const unchanged = (
  first: Awaited<ReturnType<typeof promises.stat>>,
  second: Awaited<ReturnType<typeof promises.stat>>,
) =>
  first.dev === second.dev &&
  first.ino === second.ino &&
  first.size === second.size &&
  first.mtimeMs === second.mtimeMs &&
  first.ctimeMs === second.ctimeMs

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const config = yield* Effect.serviceOption(Config.Service)
    const directory = path.join(global.data, MANAGED_DIRECTORY)
    const limits = Effect.fn("ToolOutputStore.limits")(function* () {
      if (Option.isNone(config)) return { maxLines: MAX_LINES, maxBytes: MAX_BYTES }
      const entries = yield* config.value.entries().pipe(Effect.catch(() => Effect.succeed([] as Config.Entry[])))
      const configured = Object.assign(
        {},
        ...entries.flatMap((entry) => (entry.type === "document" ? [entry.info.tool_output ?? {}] : [])),
      )
      return { maxLines: configured.max_lines ?? MAX_LINES, maxBytes: configured.max_bytes ?? MAX_BYTES }
    })

    const write = Effect.fn("ToolOutputStore.write")(function* (content: string, input: BoundInput) {
      // UTF-8 replaces lone surrogates; tag only those artifacts and preserve their exact UTF-16 code units.
      const utf16 = !content.isWellFormed()
      const prefix =
        input.assistantMessageID === undefined
          ? "tool"
          : `tool_${ownership({ ...input, assistantMessageID: input.assistantMessageID })}`
      const file = path.join(directory, `${prefix}_${Identifier.ascending()}${utf16 ? ".utf16le" : ""}`)
      yield* fs.ensureDir(directory).pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      yield* (
        utf16
          ? fs.writeFile(file, Buffer.from(content, "utf16le"), { flag: "wx" })
          : fs.writeFileString(file, content, { flag: "wx" })
      ).pipe(Effect.mapError((cause) => new StorageError({ operation: "write", cause })))
      return file
    })

    const bound = Effect.fn("ToolOutputStore.bound")(function* (input: BoundInput) {
      const outputLimits = yield* limits()
      const media = input.output.content.filter((item) => item.type === "file")
      const text = input.output.content.filter((item) => item.type === "text")
      const contextual =
        input.output.content.length === 0
          ? yield* Effect.try({
              try: () => JSON.stringify(input.output.structured, null, 2) ?? String(input.output.structured),
              catch: (cause) => new StorageError({ operation: "encode", cause }),
            })
          : text.map((item) => item.text).join("")
      if (
        lineCount(contextual) <= outputLimits.maxLines &&
        Buffer.byteLength(contextual, "utf-8") <= outputLimits.maxBytes
      )
        return {
          output: input.output,
          outputPaths: [],
        }

      const outputPath = yield* write(contextual, input)
      const recovery =
        input.assistantMessageID === undefined
          ? ""
          : `recover with tool_result(${JSON.stringify({ messageID: input.assistantMessageID, callID: input.toolCallID })}); `
      const marker = `... output truncated; ${recovery}full content saved to ${outputPath} ...`

      return {
        output: {
          structured: input.output.structured,
          content: [
            {
              type: "text" as const,
              text: boundedPreview(contextual, marker, outputLimits.maxLines, outputLimits.maxBytes),
            },
            ...media,
          ],
        },
        outputPaths: [outputPath],
      }
    })

    const page = Effect.fn("ToolOutputStore.page")(function* (input: PageInput) {
      if (input.outputPaths.length !== 1) return yield* new ReadError({ reason: "references" })
      if (
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > TextPage.MAX_UNITS
      )
        return yield* new ReadError({ reason: "range" })
      const file = input.outputPaths[0]!
      if (!path.isAbsolute(file) || path.dirname(path.resolve(file)) !== path.resolve(directory))
        return yield* new ReadError({ reason: "path" })
      const match = /^tool_([a-f0-9]{64})_[A-Za-z0-9]+(\.utf16le)?$/.exec(path.basename(file))
      if (!match) return yield* new ReadError({ reason: "legacy" })
      if (match[1] !== ownership(input)) return yield* new ReadError({ reason: "ownership" })

      // Node handles are needed here for no-follow opening, identity checks, and bounded positional reads.
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const initial = yield* Effect.tryPromise({
            try: async () => {
              const root = await promises.realpath(global.data)
              const managed = await promises.lstat(directory)
              if (managed.isSymbolicLink() || !managed.isDirectory()) throw new ReadError({ reason: "path" })
              const canonical = await promises.realpath(directory)
              if (canonical !== path.join(root, MANAGED_DIRECTORY)) throw new ReadError({ reason: "path" })
              const info = await promises.lstat(file)
              if (
                info.isSymbolicLink() ||
                !info.isFile() ||
                (await promises.realpath(file)) !== path.join(canonical, path.basename(file))
              )
                throw new ReadError({ reason: "path" })
              if (info.mtimeMs < Date.now() - Duration.toMillis(RETENTION)) throw new ReadError({ reason: "expired" })
              return { info, canonical }
            },
            catch: readFailure,
          })
          const handle = yield* Effect.acquireRelease(
            Effect.tryPromise({
              try: () =>
                promises.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)),
              catch: readFailure,
            }),
            (opened) => Effect.promise(() => opened.close()).pipe(Effect.ignore),
          )
          const before = yield* Effect.tryPromise({ try: () => handle.stat(), catch: readFailure })
          if (!before.isFile() || !unchanged(initial.info, before)) return yield* new ReadError({ reason: "changed" })
          const source = Stream.fromAsyncIterable(
            (async function* () {
              let position = 0
              while (position < before.size) {
                const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, before.size - position))
                const result = await handle.read(buffer, 0, buffer.length, position)
                if (!result.bytesRead) throw new ReadError({ reason: "changed" })
                position += result.bytesRead
                yield buffer.subarray(0, result.bytesRead)
              }
            })(),
            readFailure,
          )
          const result = yield* TextPage.snapshot(source, {
            offset: input.offset,
            limit: input.limit,
            fatal: true,
            encoding: match[2] ? "utf16le" : "utf8",
          }).pipe(
            Effect.mapError((cause) => (cause instanceof ReadError ? cause : new ReadError({ reason: "encoding" }))),
          )
          const after = yield* Effect.tryPromise({
            try: async () => {
              const info = await promises.lstat(file)
              const managed = await promises.lstat(directory)
              if (
                info.isSymbolicLink() ||
                !info.isFile() ||
                managed.isSymbolicLink() ||
                !managed.isDirectory() ||
                (await promises.realpath(directory)) !== initial.canonical ||
                (await promises.realpath(file)) !== path.join(initial.canonical, path.basename(file))
              )
                throw new ReadError({ reason: "changed" })
              return { info, opened: await handle.stat() }
            },
            catch: readFailure,
          })
          // Detect ordinary replacement/mutation; metadata checks cannot promise an atomic snapshot against hostile writers.
          if (!unchanged(before, after.info) || !unchanged(before, after.opened))
            return yield* new ReadError({ reason: "changed" })
          return result
        }),
      )
    })

    const cleanup = Effect.fn("ToolOutputStore.cleanup")(function* () {
      const entries = yield* fs.readDirectory(directory).pipe(Effect.catch(() => Effect.succeed([])))
      const cutoff = Date.now() - Duration.toMillis(RETENTION)
      for (const entry of entries) {
        if (!entry.startsWith("tool_")) continue
        const file = path.join(directory, entry)
        const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.void))
        const modified = info?.mtime.pipe(
          Option.map((date) => date.getTime()),
          Option.getOrElse(() => 0),
        )
        if (modified !== undefined && modified < cutoff) yield* fs.remove(file).pipe(Effect.catch(() => Effect.void))
      }
    })

    return Service.of({ limits, bound, page, cleanup })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node, Config.node] })

export const nodeWithoutConfig = makeLocationNode({ service: Service, layer, deps: [FSUtil.node, Global.node] })

/** Runs retention scanning once globally rather than once per active Location. */
export const cleanupLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* Service
    yield* store.cleanup().pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const cleanupNode = makeGlobalNode({
  name: "tool-output-cleanup",
  layer: Layer.merge(layer, cleanupLayer.pipe(Layer.provide(layer))),
  deps: [FSUtil.node, Global.node],
})
