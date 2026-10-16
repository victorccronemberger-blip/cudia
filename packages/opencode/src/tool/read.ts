import { Effect, Option, Schema, Scope, Stream } from "effect"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import path from "path"
import { createHash } from "node:crypto"
import { Tool } from "./tool"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LSP } from "@/lsp/lsp"
import DESCRIPTION from "./read.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import { isPdfAttachment, sniffAttachmentMime } from "@/util/media"
import { Truncate } from "./truncate"
import { TextPage } from "../util/text-page"
import { BoundedFile } from "@opencode-ai/core/util/bounded-file"
import { OutputBudget } from "@opencode-ai/core/util/output-budget"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_MEDIA_INGEST_BYTES = 20 * 1024 * 1024
const SAMPLE_BYTES = 4096
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])

class ReadStop extends Schema.TaggedErrorClass<ReadStop>()("ReadStop", {}) {}

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file or directory to read" }),
  offset: Schema.optional(PositiveInt).annotate({
    description: "The line or directory entry to start reading from (1-indexed)",
  }),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(DEFAULT_READ_LIMIT))).annotate({
    description: "The maximum number of lines or directory entries to read (1-2000; defaults to 2000)",
  }),
  snapshot: Schema.optional(Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/))).annotate({
    description:
      "Directory snapshot from the first page; required with directory offsets above 1. A changed listing requires restarting at offset 1.",
  }),
  textPage: Schema.optional(
    Schema.Struct({
      offset: Schema.optional(NonNegativeInt),
      limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(TextPage.MAX_UNITS))),
      contentHash: Schema.optional(Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/))),
    }),
  ).annotate({
    description:
      "Read exact text in UTF-16 pages, including long lines. Start with {}; continue with returned nextOffset and contentHash. Do not combine with line offset/limit.",
  }),
})

type Display =
  | {
      type: "directory"
      path: string
      entries: string[]
      offset: number
      totalEntries: number
      truncated: boolean
    }
  | {
      type: "file"
      path: string
      text: string
      lineStart: number
      lineEnd: number
      totalLines?: number
      truncated: boolean
    }

type Metadata = {
  preview: string
  truncated: boolean
  loaded: string[]
  receipt?: { kind: "batch" | "page"; start: number; end: number }
  pendingInstructions?: boolean
  snapshot?: string
  nextOffset?: number
  display?: Display
}

export const ReadTool = Tool.define<
  typeof Parameters,
  Metadata,
  FSUtil.Service | Instruction.Service | LSP.Service | Truncate.Service | Scope.Scope
>(
  "read",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const instruction = yield* Instruction.Service
    const lsp = yield* LSP.Service
    const scope = yield* Scope.Scope
    const truncate = yield* Truncate.Service

    const prerequisites = Effect.fn("ReadTool.prerequisites")(function* (
      ctx: Tool.Context,
      filepath: string,
      authorize: (requested: string, canonical: string) => Effect.Effect<void>,
      limits: OutputBudget.Limits,
    ) {
      if (limits.maxLines < 1) return yield* Effect.fail(new Error("Instruction response exceeds the output budget."))
      // Durable storage alone does not prove that the model received an instruction.
      const prepared = yield* instruction.prepare(
        ctx.messages.filter((message) => message.info.sessionID === ctx.sessionID),
        filepath,
        authorize,
        {
          maxBytes: Math.min(16 * 1024, limits.maxBytes),
        },
      )
      if (!OutputBudget.fits(prepared.output, limits))
        return yield* Effect.fail(new Error("Instruction response exceeds the output budget."))
      return prepared
    })

    const pending = (title: string, prepared: { output: string; loaded: string[] }) => ({
      title,
      output: prepared.output,
      metadata: {
        preview: prepared.output.slice(0, 2000),
        truncated: false,
        loaded: prepared.loaded,
        pendingInstructions: true,
        receipt: { kind: "batch" as const, start: 0, end: prepared.output.length },
      },
    })

    const miss = Effect.fn("ReadTool.miss")(function* (filepath: string) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)
      const items = yield* fs.readDirectoryEntriesBounded(dir).pipe(
        Effect.map((items) =>
          items
            .map((item) => item.name)
            .filter(
              (item) =>
                item.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(item.toLowerCase()),
            )
            .map((item) => path.join(dir, item))
            .slice(0, 3),
        ),
        Effect.catch(() => Effect.succeed([] as string[])),
      )

      if (items.length > 0) {
        return yield* Effect.fail(
          new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${items.join("\n")}`),
        )
      }

      return yield* Effect.fail(new Error(`File not found: ${filepath}`))
    })

    const list = Effect.fn("ReadTool.list")(function* (filepath: string) {
      const items = yield* fs.readDirectoryEntriesBounded(filepath)
      return yield* Effect.forEach(
        items,
        Effect.fnUntraced(function* (item) {
          if (item.type === "directory") return item.name + "/"
          if (item.type !== "symlink") return item.name

          const target = yield* fs.stat(path.join(filepath, item.name)).pipe(Effect.catch(() => Effect.void))
          if (target?.type === "Directory") return item.name + "/"
          return item.name
        }),
        { concurrency: 16 },
      ).pipe(Effect.map((items: string[]) => items.sort((a, b) => a.localeCompare(b))))
    })

    const warm = Effect.fn("ReadTool.warm")(function* (filepath: string) {
      // LSP warm-up is optional; do not let a background defect fail an otherwise successful read.
      yield* lsp.touchFile(filepath).pipe(Effect.ignoreCause, Effect.forkIn(scope))
    })

    const readSample = Effect.fn("ReadTool.readSample")(function* (
      filepath: string,
      fileSize: number,
      sampleSize: number,
    ) {
      if (fileSize === 0) return new Uint8Array()

      return yield* Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fs.open(filepath, { flag: "r" })
          return Option.getOrElse(yield* file.readAlloc(Math.min(sampleSize, fileSize)), () => new Uint8Array())
        }),
      )
    })

    const lines = Effect.fn("ReadTool.lines")(function* (
      filepath: string,
      opts: { limit: number; offset: number; maxBytes: number },
    ) {
      const start = opts.offset - 1
      const raw: string[] = []
      const flags = { bytes: 0, count: 0, cut: false, lineCut: false, more: false, complete: true }
      let prefix = ""
      let hasContent = false
      const decoder = new TextDecoder("utf-8")
      const stop = () => {
        flags.more = true
        flags.complete = false
        return false
      }
      const append = (partial = false, eof = false) => {
        flags.count++
        const text = prefix.endsWith("\r") ? prefix.slice(0, -1) : prefix
        prefix = ""
        hasContent = false
        if (flags.count <= start) return true
        const abbreviated = partial || text.length > MAX_LINE_LENGTH
        // Keep valid surrogate pairs together when abbreviating the human-readable view.
        const end =
          text.charCodeAt(MAX_LINE_LENGTH - 1) >= 0xd800 && text.charCodeAt(MAX_LINE_LENGTH - 1) <= 0xdbff
            ? MAX_LINE_LENGTH - 1
            : MAX_LINE_LENGTH
        const line = abbreviated ? text.slice(0, end) + MAX_LINE_SUFFIX : text
        const size = Buffer.byteLength(`${flags.count}: ${line}`, "utf8") + (raw.length > 0 ? 1 : 0)
        if (flags.bytes + size > opts.maxBytes) {
          flags.cut = true
          return stop()
        }
        raw.push(line)
        flags.bytes += size
        if (abbreviated) {
          flags.lineCut = true
          if (eof) return true
          return stop()
        }
        return true
      }
      const consume = (text: string) => {
        let position = 0
        while (position < text.length) {
          if (raw.length >= opts.limit) return stop()
          const newline = text.indexOf("\n", position)
          const end = newline === -1 ? text.length : newline
          if (end > position) hasContent = true
          if (flags.count >= start) {
            prefix += text.slice(position, Math.min(end, position + MAX_LINE_LENGTH + 2 - prefix.length))
            // The extra two code units distinguish a trailing CR from an overlong line without buffering it.
            if (prefix.length > MAX_LINE_LENGTH + 1) return append(true)
          }
          if (newline === -1) return true
          if (!append()) return false
          position = newline + 1
        }
        return true
      }
      yield* fs.stream(filepath, { chunkSize: 64 * 1024 }).pipe(
        Stream.runForEach((bytes) =>
          consume(decoder.decode(bytes, { stream: true })) ? Effect.void : Effect.fail(new ReadStop()),
        ),
        Effect.catchTag("ReadStop", () => Effect.void),
      )
      if (flags.complete) {
        consume(decoder.decode())
        if (flags.complete && hasContent) append(false, true)
      }
      return { raw, ...flags, offset: opts.offset }
    })

    const isBinaryFile = (filepath: string, bytes: Uint8Array) => {
      const ext = path.extname(filepath).toLowerCase()
      switch (ext) {
        case ".zip":
        case ".tar":
        case ".gz":
        case ".exe":
        case ".dll":
        case ".so":
        case ".class":
        case ".jar":
        case ".war":
        case ".7z":
        case ".doc":
        case ".docx":
        case ".xls":
        case ".xlsx":
        case ".ppt":
        case ".pptx":
        case ".odt":
        case ".ods":
        case ".odp":
        case ".bin":
        case ".dat":
        case ".obj":
        case ".o":
        case ".a":
        case ".lib":
        case ".wasm":
        case ".pyc":
        case ".pyo":
          return true
      }

      if (bytes.length === 0) return false

      let nonPrintableCount = 0
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0) return true
        if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
          nonPrintableCount++
        }
      }

      return nonPrintableCount / bytes.length > 0.3
    }

    const run = Effect.fn("ReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const instance = yield* InstanceState.context
      const requested = FSUtil.windowsPath(params.filePath)
      const alias = path.resolve(path.isAbsolute(requested) ? requested : path.join(instance.directory, requested))
      const filepath = process.platform === "win32" ? FSUtil.normalizePath(alias) : alias

      const stat = yield* fs.stat(filepath).pipe(
        Effect.catchIf(
          (err) => "reason" in err && err.reason._tag === "NotFound",
          () => Effect.succeed(undefined),
        ),
      )

      const canonical = stat ? yield* fs.realPath(filepath) : filepath
      const canonicalWorktree = yield* fs.realPath(instance.worktree)
      const title = path.relative(instance.worktree, canonical)
      const kind = stat?.type === "Directory" ? "directory" : "file"
      const bypass = Boolean(ctx.extra?.["bypassCwdCheck"])
      const authorizeRead = Effect.fnUntraced(function* (requested: string, resolved: string, instruction = false) {
        const paths = requested === resolved ? [resolved] : [requested, resolved]
        for (const candidate of paths) {
          yield* assertExternalDirectoryEffect(ctx, candidate, { bypass, kind: instruction ? "file" : kind })
          yield* ctx.ask({
            permission: "read",
            patterns: [path.relative(candidate === resolved ? canonicalWorktree : instance.worktree, candidate)],
            always: ["*"],
            metadata: { filepath: candidate, instruction },
          })
        }
      })

      yield* authorizeRead(alias, canonical)

      const limits = OutputBudget.resolve(yield* truncate.limits(), {
        maxLines: DEFAULT_READ_LIMIT,
        maxBytes: MAX_BYTES,
      })

      if (params.textPage && (params.offset !== undefined || params.limit !== undefined))
        return yield* Effect.fail(
          new Error("Use textPage offsets and limits without the line offset/limit parameters."),
        )

      if (!stat) return yield* miss(filepath)

      if (stat.type === "Directory") {
        if (params.textPage) return yield* Effect.fail(new Error("Text pages require a text file."))
        const offset = params.offset ?? 1
        if (offset > 1 && params.snapshot === undefined)
          return yield* Effect.fail(new Error("Pass snapshot from the first directory page when continuing."))
        const items = yield* list(canonical)
        const snapshot = createHash("sha256")
          .update(JSON.stringify([canonical, items]))
          .digest("hex")
        if (params.snapshot !== undefined && params.snapshot !== snapshot)
          return yield* Effect.fail(new Error("Directory listing changed. Restart at offset 1 without snapshot."))
        if (offset > items.length + 1)
          return yield* Effect.fail(
            new Error(`Offset ${offset} is out of range for this directory (${items.length} entries)`),
          )
        const start = offset - 1
        const sliced: string[] = []
        let bytes = 0
        for (const item of items.slice(start, start + Math.min(params.limit ?? DEFAULT_READ_LIMIT, limits.maxLines))) {
          const size = Buffer.byteLength(item, "utf8") + (sliced.length ? 1 : 0)
          if (bytes + size > limits.maxBytes) break
          sliced.push(item)
          bytes += size
        }
        const render = () =>
          [
            `<path>${canonical}</path>`,
            `<type>directory</type>`,
            `<entries>`,
            sliced.join("\n"),
            start + sliced.length < items.length
              ? `\n(Showing ${sliced.length} of ${items.length} entries. Use offset=${offset + sliced.length} and snapshot=${snapshot} to continue.)`
              : `\n(${items.length} entries; snapshot=${snapshot})`,
            `</entries>`,
          ].join("\n")
        let output = render()
        while (!OutputBudget.fits(output, limits) && sliced.length) {
          sliced.pop()
          output = render()
        }
        if (!OutputBudget.fits(output, limits) || (sliced.length === 0 && start < items.length))
          return yield* Effect.fail(
            new Error("Directory response cannot include the next complete entry within the output budget."),
          )
        const truncated = start + sliced.length < items.length

        return {
          title,
          output,
          metadata: {
            preview: sliced.slice(0, 20).join("\n"),
            truncated,
            loaded: [] as string[],
            snapshot,
            ...(truncated ? { nextOffset: offset + sliced.length } : {}),
            display: {
              type: "directory" as const,
              path: canonical,
              entries: sliced,
              offset,
              totalEntries: items.length,
              truncated,
            },
          },
        }
      }

      if (stat.type !== "File") return yield* Effect.fail(new Error(`Cannot read a nonregular file: ${canonical}`))
      if (params.snapshot !== undefined)
        return yield* Effect.fail(new Error("snapshot is only supported for directory pages."))

      const sample = yield* readSample(canonical, Number(stat.size), SAMPLE_BYTES)

      const mime = sniffAttachmentMime(sample, FSUtil.mimeType(canonical))
      const isImage = SUPPORTED_IMAGE_MIMES.has(mime)

      if (params.textPage) {
        if (isImage || isPdfAttachment(mime) || isBinaryFile(canonical, sample))
          return yield* Effect.fail(new Error("Text pages require a text file."))
        const document = yield* instruction.isDocument(canonical)
        if (!document) {
          const prepared = yield* prerequisites(
            ctx,
            canonical,
            (requested, resolved) => authorizeRead(requested, resolved, true),
            limits,
          )
          // Deliver a bounded instruction batch first; it becomes authoritative only after recording.
          if (prepared.pending || prepared.loaded.length) return pending(title, prepared)
        }

        const offset = params.textPage.offset ?? 0
        const limit = params.textPage.limit ?? TextPage.MAX_UNITS
        const snapshot = yield* TextPage.snapshot(fs.stream(canonical), { offset, limit })
        if (params.textPage.contentHash !== undefined && params.textPage.contentHash !== snapshot.contentHash)
          return yield* Effect.fail(
            new Error("File content changed. Restart textPage at offset 0 without contentHash."),
          )
        if (offset > 0 && params.textPage.contentHash === undefined)
          return yield* Effect.fail(new Error("Pass contentHash from the first text page when continuing."))
        if (offset > snapshot.totalLength) return yield* Effect.fail(new Error("Text page offset is outside the file."))
        if (limits.maxLines < 1) return yield* Effect.fail(new Error("Text page exceeds the output budget."))
        const page = TextPage.format(
          snapshot.text,
          {
            offset: offset - snapshot.start,
            limit,
            maxBytes: Math.min(TextPage.MAX_BYTES, limits.maxBytes),
          },
          (end) =>
            JSON.stringify({
              filepath: canonical,
              contentHash: snapshot.contentHash,
              text: snapshot.text.slice(offset - snapshot.start, end),
              offset,
              nextOffset: snapshot.start + end,
              totalLength: snapshot.totalLength,
              complete: snapshot.start + end === snapshot.totalLength,
              offsetUnit: "utf16_code_units",
            }),
        )
        if (!page.ok) {
          const message = {
            offset: "Text page offset is outside the file.",
            surrogate: "Text page offset falls inside a Unicode surrogate pair.",
            character: "Text page limit cannot include the next Unicode character.",
            budget: "Text page envelope exceeds the output budget.",
          }[page.error]
          return yield* Effect.fail(new Error(message))
        }
        return {
          title,
          output: page.output,
          metadata: {
            preview: snapshot.text.slice(offset - snapshot.start, Math.min(page.end, offset - snapshot.start + 2000)),
            truncated: false,
            loaded: [] as string[],
            ...(document ? { receipt: { kind: "page" as const, start: 0, end: page.output.length } } : {}),
          },
        }
      }

      if (isImage || isPdfAttachment(mime)) {
        const prepared = yield* prerequisites(
          ctx,
          canonical,
          (requested, resolved) => authorizeRead(requested, resolved, true),
          limits,
        )
        if (prepared.pending || prepared.loaded.length) return pending(title, prepared)
        const msg = isPdfAttachment(mime) ? "PDF read successfully" : "Image read successfully"
        if (!OutputBudget.fits(msg, limits))
          return yield* Effect.fail(new Error("Media response exceeds the output budget."))
        const bytes = yield* BoundedFile.read(fs, canonical, MAX_MEDIA_INGEST_BYTES).pipe(
          Effect.mapError((error) =>
            error instanceof BoundedFile.LimitError
              ? new Error(`Media exceeds ${MAX_MEDIA_INGEST_BYTES} byte ingestion limit: ${canonical}`)
              : error,
          ),
        )
        return {
          title,
          output: msg,
          metadata: {
            preview: msg,
            truncated: false,
            loaded: [] as string[],
          },
          attachments: [
            {
              type: "file" as const,
              mime,
              url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
            },
          ],
        }
      }

      if (isBinaryFile(canonical, sample)) {
        return yield* Effect.fail(new Error(`Cannot read binary file: ${canonical}`))
      }

      const prepared = yield* prerequisites(
        ctx,
        canonical,
        (requested, resolved) => authorizeRead(requested, resolved, true),
        limits,
      )
      if (prepared.pending || prepared.loaded.length) return pending(title, prepared)

      const file = yield* lines(canonical, {
        limit: Math.min(params.limit ?? DEFAULT_READ_LIMIT, limits.maxLines),
        offset: params.offset ?? 1,
        maxBytes: limits.maxBytes,
      })
      if (file.count < file.offset && !(file.count === 0 && file.offset === 1)) {
        return yield* Effect.fail(
          new Error(`Offset ${file.offset} is out of range for this file (${file.count} lines)`),
        )
      }

      const raw = [...file.raw]
      const render = () => {
        const last = file.offset + raw.length - 1
        const more = file.more || raw.length < file.raw.length
        const footer =
          file.lineCut && raw.length === file.raw.length
            ? "(Some lines were abbreviated. Use textPage: {} to read exact text, then continue with nextOffset and contentHash.)"
            : file.cut || raw.length < file.raw.length
              ? `(Output capped at ${limits.maxBytes === MAX_BYTES ? "50 KB" : `${limits.maxBytes} bytes`} or ${limits.maxLines} lines. Showing lines ${file.offset}-${last}. Use offset=${last + 1} to continue.)`
              : more
                ? `(Showing lines ${file.offset}-${last}. Use offset=${last + 1} to continue.)`
                : `(End of file - total ${file.count} lines)`
        return [
          `<path>${canonical}</path>`,
          `<type>file</type>`,
          "<content>\n",
          raw.map((line, index) => `${index + file.offset}: ${line}`).join("\n"),
          `\n${footer}`,
          "</content>",
        ].join("\n")
      }
      let output = render()
      while (!OutputBudget.fits(output, limits) && raw.length) {
        raw.pop()
        output = render()
      }
      if (!OutputBudget.fits(output, limits) || (raw.length === 0 && (file.raw.length > 0 || file.more)))
        return yield* Effect.fail(
          new Error(
            "File response cannot include the next line within the output budget. Use textPage: {} for exact bounded text.",
          ),
        )
      const last = file.offset + raw.length - 1
      const lineCut = file.lineCut && raw.length === file.raw.length
      const truncated = file.more || file.cut || file.lineCut || raw.length < file.raw.length

      yield* warm(canonical)

      return {
        title,
        output,
        metadata: {
          preview: raw.slice(0, 20).join("\n"),
          truncated,
          loaded: [] as string[],
          ...(!lineCut && truncated ? { nextOffset: last + 1 } : {}),
          display: {
            type: "file" as const,
            path: canonical,
            text: raw.join("\n"),
            lineStart: file.offset,
            lineEnd: last,
            ...(file.complete ? { totalLines: file.count } : {}),
            truncated,
          },
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
