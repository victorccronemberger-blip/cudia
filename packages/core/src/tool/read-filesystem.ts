export * as ReadToolFileSystem from "./read-filesystem"

import path from "path"
import { pathToFileURL } from "url"
import { Context, Effect, Layer, Option, Schema, Stream } from "effect"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { makeLocationNode } from "../effect/app-node"
import { AbsolutePath, NonNegativeInt, PositiveInt, RelativePath } from "../schema"
import { BoundedFile } from "../util/bounded-file"
import { OutputBudget } from "../util/output-budget"
import { DecodeError, MAX_BYTES, MAX_UNITS, format, hash, snapshot } from "../util/text-page"

export const MAX_READ_LINES = 2_000
export const MAX_READ_BYTES = 50 * 1024
export const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024
const MAX_LINE_LENGTH = 2_000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
export const DEFAULT_BUDGET = { maxBytes: MAX_READ_BYTES, maxLines: MAX_READ_LINES }

export class BudgetError extends Schema.TaggedErrorClass<BudgetError>()("ReadTool.BudgetError", {}) {
  override get message() {
    return "Read response cannot fit the output budget; use textPage for a smaller text window"
  }
}

export class SnapshotError extends Schema.TaggedErrorClass<SnapshotError>()("ReadTool.SnapshotError", {}) {
  override get message() {
    return "Directory snapshot is missing or changed; restart at offset 1 and continue with its snapshot"
  }
}

export class TextPageError extends Schema.TaggedErrorClass<TextPageError>()("ReadTool.TextPageError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Cannot read exact text page: ${this.reason}`
  }
}

export class BinaryFileError extends Schema.TaggedErrorClass<BinaryFileError>()("ReadTool.BinaryFileError", {
  resource: Schema.String,
}) {
  override get message() {
    return `Cannot read binary file: ${this.resource}`
  }
}

export class MediaIngestLimitError extends Schema.TaggedErrorClass<MediaIngestLimitError>()(
  "ReadTool.MediaIngestLimitError",
  {
    resource: Schema.String,
    maximumBytes: Schema.Number,
  },
) {
  override get message() {
    return `Media exceeds ${this.maximumBytes} byte ingestion limit: ${this.resource}`
  }
}

export class MalformedUtf8Error extends Schema.TaggedErrorClass<MalformedUtf8Error>()("ReadTool.MalformedUtf8Error", {
  resource: Schema.String,
}) {
  override get message() {
    return `File is not valid UTF-8: ${this.resource}`
  }
}

export class OffsetOutOfRangeError extends Schema.TaggedErrorClass<OffsetOutOfRangeError>()(
  "ReadTool.OffsetOutOfRangeError",
  { offset: Schema.Number },
) {
  override get message() {
    return `Offset ${this.offset} is out of range`
  }
}

export class PathKindError extends Schema.TaggedErrorClass<PathKindError>()("ReadTool.PathKindError", {
  resource: Schema.String,
  expected: Schema.Literals(["a file", "a file or directory"]),
}) {
  override get message() {
    return `Path is not ${this.expected}: ${this.resource}`
  }
}

export type InspectError = FSUtil.Error | PathKindError
export type ReadError =
  | FSUtil.Error
  | BinaryFileError
  | MediaIngestLimitError
  | MalformedUtf8Error
  | OffsetOutOfRangeError
  | PathKindError
  | BoundedFile.SourceError
  | BudgetError
  | SnapshotError
  | TextPageError

export const PageInput = Schema.Struct({
  offset: PositiveInt.pipe(Schema.optional),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_READ_LINES)).pipe(Schema.optional),
  snapshot: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/)).pipe(Schema.optional),
})
export type PageInput = typeof PageInput.Type

export const ExactInput = Schema.Struct({
  offset: NonNegativeInt.pipe(Schema.optional),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_UNITS)).pipe(Schema.optional),
  contentHash: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/)).pipe(Schema.optional),
})
export type ExactInput = typeof ExactInput.Type

export class ExactPage extends Schema.Class<ExactPage>("ReadTool.ExactPage")({
  path: Schema.String,
  text: Schema.String,
  contentHash: Schema.String,
  offset: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
  totalLength: NonNegativeInt,
  complete: Schema.Boolean,
  offsetUnit: Schema.Literal("utf16_code_units"),
}) {}

export class TextPage extends Schema.Class<TextPage>("ReadTool.TextPage")({
  type: Schema.Literal("text-page"),
  content: Schema.String,
  mime: Schema.String,
  offset: PositiveInt,
  truncated: Schema.Boolean,
  next: PositiveInt.pipe(Schema.optional),
  lineTruncated: Schema.Boolean.pipe(Schema.optional),
  recovery: Schema.Struct({ textPage: Schema.Struct({}) }).pipe(Schema.optional),
}) {}

export class ListPage extends Schema.Class<ListPage>("ReadTool.ListPage")({
  entries: Schema.Array(FileSystem.Entry),
  truncated: Schema.Boolean,
  next: PositiveInt.pipe(Schema.optional),
  snapshot: Schema.String.pipe(Schema.optional),
}) {}

export interface Interface {
  readonly inspect: (path: AbsolutePath) => Effect.Effect<"file" | "directory", InspectError>
  readonly read: (
    path: AbsolutePath,
    resource: string,
    page?: PageInput,
    budget?: OutputBudget.Limits,
  ) => Effect.Effect<FileSystem.Content | TextPage, ReadError>
  readonly exact: (
    path: AbsolutePath,
    resource: string,
    page?: ExactInput,
    budget?: OutputBudget.Limits,
  ) => Effect.Effect<ExactPage, ReadError>
  readonly list: (
    path: AbsolutePath,
    page?: PageInput,
    budget?: OutputBudget.Limits,
  ) => Effect.Effect<ListPage, ReadError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ReadToolFileSystem") {}

const extensions = new Set([
  ".zip",
  ".tar",
  ".gz",
  ".exe",
  ".dll",
  ".so",
  ".class",
  ".jar",
  ".war",
  ".7z",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".odt",
  ".ods",
  ".odp",
  ".bin",
  ".dat",
  ".obj",
  ".o",
  ".a",
  ".lib",
  ".wasm",
  ".pyc",
  ".pyo",
])
const startsWith = (bytes: Uint8Array, prefix: number[]) => prefix.every((value, index) => bytes[index] === value)
const imageMime = (bytes: Uint8Array) => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png"
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg"
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif"
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return "image/webp"
}
const binary = (resource: string, bytes: Uint8Array) => {
  if (extensions.has(path.extname(resource).toLowerCase())) return true
  if (bytes.length === 0) return false
  let nonPrintable = 0
  for (const byte of bytes) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++
  }
  return nonPrintable / bytes.length > 0.3
}
const decodeUtf8 = (resource: string, decoder: TextDecoder, bytes?: Uint8Array) =>
  Effect.try({
    try: () => decoder.decode(bytes, { stream: bytes !== undefined }),
    catch: (error) => {
      if (error instanceof TypeError) return new MalformedUtf8Error({ resource })
      throw error
    },
  })
const decodeChunk = (resource: string, decoder: TextDecoder, bytes: Uint8Array) =>
  bytes.includes(0) ? Effect.fail(new BinaryFileError({ resource })) : decodeUtf8(resource, decoder, bytes)

export const inspect = Effect.fn("ReadTool.inspect")(function* (fs: FSUtil.Interface, input: string) {
  const info = yield* fs.stat(input)
  const type = info.type === "File" ? "file" : info.type === "Directory" ? "directory" : undefined
  if (!type) return yield* Effect.fail(new PathKindError({ resource: input, expected: "a file or directory" }))
  return type
})

export const read = Effect.fn("ReadTool.read")(function* (
  fs: FSUtil.Interface,
  input: string,
  resource: string,
  page: PageInput = {},
  budget: OutputBudget.Limits = DEFAULT_BUDGET,
) {
  if (page.snapshot !== undefined) return yield* new SnapshotError()
  const real = yield* fs.realPath(input)
  if (path.resolve(real) !== path.resolve(input)) return yield* new BoundedFile.SourceError({ reason: "changed" })
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(real, { flag: "r" })
      const info = yield* file.stat
      if (info.type !== "File") return yield* Effect.fail(new PathKindError({ resource, expected: "a file" }))
      const verify = Effect.gen(function* () {
        if (
          (yield* fs.realPath(input)) !== real ||
          !BoundedFile.unchanged(info, yield* file.stat) ||
          !BoundedFile.unchanged(info, yield* fs.stat(real))
        )
          return yield* new BoundedFile.SourceError({ reason: "changed" })
      })
      const first = Option.getOrElse(
        yield* file.readAlloc(Math.min(64 * 1024, Number(info.size) || 4 * 1024)),
        () => new Uint8Array(),
      )
      const mime = imageMime(first)
      if (mime) {
        if (info.size > MAX_MEDIA_INGEST_BYTES)
          return yield* Effect.fail(new MediaIngestLimitError({ resource, maximumBytes: MAX_MEDIA_INGEST_BYTES }))
        const chunks = [first]
        let total = first.length
        while (total <= MAX_MEDIA_INGEST_BYTES) {
          const chunk = yield* file.readAlloc(Math.min(64 * 1024, MAX_MEDIA_INGEST_BYTES + 1 - total))
          if (Option.isNone(chunk)) break
          chunks.push(chunk.value)
          total += chunk.value.length
        }
        if (total > MAX_MEDIA_INGEST_BYTES)
          return yield* Effect.fail(new MediaIngestLimitError({ resource, maximumBytes: MAX_MEDIA_INGEST_BYTES }))
        yield* verify
        return {
          uri: pathToFileURL(real).href,
          name: path.basename(real),
          content: Buffer.concat(
            chunks.map((chunk) => Buffer.from(chunk)),
            total,
          ).toString("base64"),
          encoding: "base64" as const,
          mime,
        }
      }
      if (startsWith(first, [0x25, 0x50, 0x44, 0x46]) || extensions.has(path.extname(resource).toLowerCase()))
        return yield* Effect.fail(new BinaryFileError({ resource }))
      const paged = info.size > MAX_READ_BYTES || page.offset !== undefined || page.limit !== undefined
      if (!paged) {
        if (binary(resource, first)) return yield* Effect.fail(new BinaryFileError({ resource }))
        const decoder = new TextDecoder("utf-8", { fatal: true })
        const text = [yield* decodeUtf8(resource, decoder, first)]
        let total = first.length
        while (true) {
          const chunk = yield* file.readAlloc(Math.min(64 * 1024, MAX_READ_BYTES + 1 - total))
          if (Option.isNone(chunk)) break
          total += chunk.value.length
          if (total > MAX_READ_BYTES) return yield* new BoundedFile.SourceError({ reason: "changed" })
          text.push(yield* decodeChunk(resource, decoder, chunk.value))
        }
        text.push(yield* decodeUtf8(resource, decoder))
        const content = {
          uri: pathToFileURL(real).href,
          name: path.basename(real),
          content: text.join(""),
          encoding: "utf8" as const,
          mime: FSUtil.mimeType(real),
        }
        yield* verify
        if (OutputBudget.fits(JSON.stringify(content), budget)) return content
        // Reuse the opened source for a smaller line page when metadata/escaping makes Content too large.
        yield* file.seek(first.length, "start")
      }
      const offset = page.offset ?? 1
      const limit = Math.min(page.limit ?? MAX_READ_LINES, MAX_READ_LINES)
      const lines: string[] = []
      const decoder = new TextDecoder("utf-8", { fatal: true })
      let pending = ""
      let discard = false
      let line = 1
      let bytes = 0
      let next: number | undefined
      let partialLine = false
      const abbreviated: boolean[] = []
      const append = (input: string) => {
        if (line < offset) {
          line++
          return true
        }
        if (lines.length >= limit || bytes >= MAX_READ_BYTES) {
          next = line
          return false
        }
        const end =
          input.charCodeAt(MAX_LINE_LENGTH - 1) >= 0xd800 &&
          input.charCodeAt(MAX_LINE_LENGTH - 1) <= 0xdbff &&
          input.charCodeAt(MAX_LINE_LENGTH) >= 0xdc00 &&
          input.charCodeAt(MAX_LINE_LENGTH) <= 0xdfff
            ? MAX_LINE_LENGTH - 1
            : MAX_LINE_LENGTH
        const text = input.length > MAX_LINE_LENGTH ? input.slice(0, end) + MAX_LINE_SUFFIX : input
        const size = Buffer.byteLength(text, "utf-8") + (lines.length > 0 ? 1 : 0)
        if (bytes + size > MAX_READ_BYTES) {
          next = line
          return false
        }
        lines.push(text)
        abbreviated.push(input.length > MAX_LINE_LENGTH)
        bytes += size
        line++
        return true
      }
      const consume = (input: string) => {
        let text = input
        while (true) {
          const index = text.indexOf("\n")
          if (index === -1) {
            if (!discard) {
              pending += text
              if (pending.length > MAX_LINE_LENGTH) {
                pending = pending.slice(0, MAX_LINE_LENGTH + 1)
                discard = true
                if (line >= offset) {
                  const count = lines.length
                  append(pending)
                  partialLine = lines.length > count
                  return false
                }
              }
            }
            break
          }
          const current = pending + (discard ? "" : text.slice(0, index))
          pending = ""
          discard = false
          text = text.slice(index + 1)
          if (!append(current.endsWith("\r") ? current.slice(0, -1) : current)) return false
        }
        return true
      }
      const consumeChunk = Effect.fnUntraced(function* (chunk: Uint8Array) {
        let start = 0
        while (start < chunk.length) {
          if (lines.length >= limit || bytes >= MAX_READ_BYTES) {
            next = line
            return false
          }
          const newline = chunk.indexOf(10, start)
          const end = newline === -1 ? chunk.length : newline + 1
          const segment = chunk.subarray(start, end)
          if (binary(resource, segment)) return yield* Effect.fail(new BinaryFileError({ resource }))
          if (!consume(yield* decodeUtf8(resource, decoder, segment))) return false
          start = end
        }
        return true
      })
      let done = !(yield* consumeChunk(first))
      while (!done) {
        const chunk = yield* file.readAlloc(64 * 1024)
        if (Option.isNone(chunk)) break
        done = !(yield* consumeChunk(chunk.value))
      }
      if (!done) {
        const tail = yield* decodeUtf8(resource, decoder)
        if (!discard) pending += tail
        if (pending) append(pending.endsWith("\r") ? pending.slice(0, -1) : pending)
      }
      if (lines.length === 0 && offset !== 1) return yield* Effect.fail(new OffsetOutOfRangeError({ offset }))
      yield* verify
      const makePage = (count: number) => {
        const lineTruncated = abbreviated.slice(0, count).some(Boolean)
        const more = count < lines.length ? offset + count : next
        return new TextPage({
          type: "text-page",
          content: lines.slice(0, count).join("\n"),
          mime: FSUtil.mimeType(real),
          offset,
          truncated: more !== undefined || lineTruncated || partialLine,
          ...(more === undefined ? {} : { next: more }),
          ...(lineTruncated ? { lineTruncated: true, recovery: { textPage: {} } } : {}),
        })
      }
      let count = lines.length
      while (count > 0 && !OutputBudget.fits(JSON.stringify(makePage(count)), budget)) count--
      const result = makePage(count)
      if ((count === 0 && lines.length > 0) || !OutputBudget.fits(JSON.stringify(result), budget))
        return yield* new BudgetError()
      return result
    }),
  )
})

export const exact = Effect.fn("ReadTool.exact")(function* (
  fs: FSUtil.Interface,
  input: string,
  resource: string,
  page: ExactInput = {},
  budget: OutputBudget.Limits = DEFAULT_BUDGET,
) {
  const offset = page.offset ?? 0
  const limit = page.limit ?? MAX_UNITS
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_UNITS)
    return yield* new TextPageError({ reason: "invalid offset or limit" })
  if (offset > 0 && page.contentHash === undefined)
    return yield* new TextPageError({ reason: "contentHash is required for nonzero offsets" })
  const real = yield* fs.realPath(input)
  if (path.resolve(real) !== path.resolve(input)) return yield* new BoundedFile.SourceError({ reason: "changed" })
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(real, { flag: "r" })
      const info = yield* file.stat
      if (info.type !== "File") return yield* new PathKindError({ resource, expected: "a file" })
      const sample = Option.getOrElse(yield* file.readAlloc(Math.min(4096, Number(info.size))), () => new Uint8Array())
      if (imageMime(sample) || startsWith(sample, [0x25, 0x50, 0x44, 0x46]) || binary(resource, sample))
        return yield* new BinaryFileError({ resource })
      yield* file.seek(0, "start")
      const source = Stream.unfold(Number(info.size), (remaining) =>
        Effect.gen(function* () {
          if (remaining === 0) return undefined
          const chunk = yield* file.readAlloc(Math.min(64 * 1024, remaining))
          if (Option.isNone(chunk)) return yield* new BoundedFile.SourceError({ reason: "changed" })
          if (chunk.value.includes(0)) return yield* new BinaryFileError({ resource })
          return [chunk.value, remaining - chunk.value.length] as const
        }),
      )
      const result = yield* snapshot(source, { offset, limit, fatal: true }).pipe(
        Effect.mapError((error) => (error instanceof DecodeError ? new MalformedUtf8Error({ resource }) : error)),
      )
      if (
        (yield* fs.realPath(input)) !== real ||
        !BoundedFile.unchanged(info, yield* file.stat) ||
        !BoundedFile.unchanged(info, yield* fs.stat(real))
      )
        return yield* new BoundedFile.SourceError({ reason: "changed" })
      if (page.contentHash !== undefined && page.contentHash !== result.contentHash)
        return yield* new TextPageError({ reason: "content changed; restart at offset 0" })
      if (offset > result.totalLength) return yield* new OffsetOutOfRangeError({ offset })
      const local = offset - result.start
      const makePage = (end: number) =>
        new ExactPage({
          path: resource,
          text: result.text.slice(local, end),
          contentHash: result.contentHash,
          offset,
          nextOffset: result.start + end < result.totalLength ? result.start + end : null,
          totalLength: result.totalLength,
          complete: result.start + end >= result.totalLength,
          offsetUnit: "utf16_code_units",
        })
      const formatted = format(
        result.text,
        { offset: local, limit, maxBytes: Math.min(MAX_BYTES, budget.maxBytes) },
        (end) => JSON.stringify(makePage(end)),
      )
      if (!formatted.ok) return yield* new TextPageError({ reason: formatted.error })
      const selected = makePage(formatted.end)
      if (!OutputBudget.fits(JSON.stringify(selected), budget)) return yield* new BudgetError()
      return selected
    }),
  )
})

export const list = Effect.fn("ReadTool.list")(function* (
  fs: FSUtil.Interface,
  input: string,
  page: PageInput = {},
  budget: OutputBudget.Limits = DEFAULT_BUDGET,
) {
  const real = yield* fs.realPath(input)
  if (path.resolve(real) !== path.resolve(input)) return yield* new BoundedFile.SourceError({ reason: "changed" })
  const items = yield* fs.readDirectoryEntriesBounded(real)
  const offset = page.offset ?? 1
  const limit = Math.min(page.limit ?? MAX_READ_LINES, MAX_READ_LINES)
  const entries = yield* Effect.forEach(
    items,
    (item) =>
      Effect.gen(function* () {
        const absolute = path.join(real, item.name)
        const target = yield* fs.realPath(absolute).pipe(Effect.catch(() => Effect.void))
        if (!target || !FSUtil.contains(real, target)) return
        const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.void))
        const type = info?.type === "Directory" ? "directory" : info?.type === "File" ? "file" : undefined
        if (!type) return
        return FileSystem.Entry.make({
          path: RelativePath.make(item.name + (type === "directory" ? path.sep : "")),
          type,
        })
      }),
    { concurrency: 16 },
  )
  const visible = entries
    .filter((item): item is FileSystem.Entry => item !== undefined)
    .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1))
  if ((yield* fs.realPath(input)) !== real) return yield* new BoundedFile.SourceError({ reason: "changed" })
  const snapshot = hash(JSON.stringify([real, visible]))
  if ((offset > 1 && page.snapshot === undefined) || (page.snapshot !== undefined && page.snapshot !== snapshot))
    return yield* new SnapshotError()
  if (offset - 1 > visible.length) return yield* new OffsetOutOfRangeError({ offset })
  const selected = visible.slice(offset - 1, offset - 1 + limit)
  const makePage = (count: number) => {
    const truncated = offset - 1 + count < visible.length
    return new ListPage({
      entries: selected.slice(0, count),
      truncated,
      snapshot,
      ...(truncated ? { next: offset + count } : {}),
    })
  }
  let count = selected.length
  while (count > 0 && !OutputBudget.fits(JSON.stringify(makePage(count)), budget)) count--
  const result = makePage(count)
  if ((count === 0 && selected.length > 0) || !OutputBudget.fits(JSON.stringify(result), budget))
    return yield* new BudgetError()
  return result
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    return Service.of({
      inspect: (path) => inspect(fs, path),
      read: (path, resource, page, budget) => read(fs, path, resource, page, budget),
      exact: (path, resource, page, budget) => exact(fs, path, resource, page, budget),
      list: (path, page, budget) => list(fs, path, page, budget),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [FSUtil.node] })
