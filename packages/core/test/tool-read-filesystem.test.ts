import { describe, expect } from "bun:test"
import path from "path"
import { promises } from "fs"
import { Effect, FileSystem } from "effect"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { BoundedFile } from "@opencode-ai/core/util/bounded-file"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem])))
const fixture = Effect.gen(function* () {
  const fs = yield* FSUtil.Service
  const files = yield* FileSystem.FileSystem
  const directory = yield* files.makeTempDirectoryScoped()
  return { fs, files, directory }
})

describe("ReadToolFileSystem", () => {
  it.effect("fails with a typed filesystem error when a resolved file disappears", () =>
    Effect.gen(function* () {
      const { fs, directory } = yield* fixture
      const file = path.join(directory, "missing.txt")

      const error = yield* ReadToolFileSystem.read(fs, file, "missing.txt").pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "PlatformError" })
    }),
  )

  it.effect("fails when a file becomes the wrong path kind", () =>
    Effect.gen(function* () {
      const { fs, directory } = yield* fixture

      const error = yield* ReadToolFileSystem.read(fs, directory, "folder").pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.PathKindError)
    }),
  )

  it.effect("fails with a typed filesystem error when directory listing fails", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "file.txt")
      yield* files.writeFileString(file, "hello")

      const error = yield* ReadToolFileSystem.list(fs, file).pipe(Effect.flip)

      expect(error).toBeInstanceOf(FSUtil.FileSystemError)
      if (error instanceof FSUtil.FileSystemError) expect(error.method).toBe("readDirectoryEntriesBounded")
    }),
  )

  it.effect("reports binary and malformed UTF-8 content as typed errors", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const binary = path.join(directory, "archive.dat")
      const malformed = path.join(directory, "malformed.txt")
      yield* files.writeFile(binary, Uint8Array.of(0, 1, 2, 3))
      const malformedContent = Uint8Array.of(97, 0x80)
      yield* files.writeFile(malformed, malformedContent)

      const binaryError = yield* ReadToolFileSystem.read(fs, binary, "archive.dat").pipe(Effect.flip)
      const malformedError = yield* ReadToolFileSystem.read(fs, malformed, "malformed.txt").pipe(Effect.flip)

      expect(binaryError).toBeInstanceOf(ReadToolFileSystem.BinaryFileError)
      expect(binaryError.message).toBe("Cannot read binary file: archive.dat")
      expect(malformedError).toBeInstanceOf(ReadToolFileSystem.MalformedUtf8Error)
    }),
  )

  it.effect("reports out-of-range pagination as a typed error", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "short.txt")
      yield* files.writeFileString(file, "one\n")

      const error = yield* ReadToolFileSystem.read(fs, file, "short.txt", { offset: 2 }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.OffsetOutOfRangeError)
      expect(error.message).toBe("Offset 2 is out of range")
    }),
  )

  it.effect("reconstructs exact UTF-16 pages across long lines, BOM, Unicode, quotes, and controls", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "exact.txt")
      const source = `\uFEFFstart ${"x".repeat(4_500)} 😀 "quoted" \\ tab\t return\r\nend`
      yield* files.writeFileString(file, source)

      const pages: string[] = []
      let offset = 0
      let contentHash: string | undefined
      while (true) {
        const result = yield* ReadToolFileSystem.exact(fs, file, "exact.txt", {
          offset,
          limit: 257,
          ...(contentHash === undefined ? {} : { contentHash }),
        })
        pages.push(result.text)
        contentHash = result.contentHash
        if (result.nextOffset === null) break
        expect(result.nextOffset).toBeGreaterThan(offset)
        offset = result.nextOffset
      }

      expect(pages.join("")).toBe(source)
      expect(offset + pages.at(-1)!.length).toBe(source.length)
      expect(contentHash).toMatch(/^[\da-f]{64}$/)
    }),
  )

  it.effect("checks exact offsets, content hashes, surrogate boundaries, and current source state", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "unicode.txt")
      yield* files.writeFileString(file, "a😀b")

      const first = yield* ReadToolFileSystem.exact(fs, file, "unicode.txt", { limit: 3 })
      expect(first.text).toBe("a😀")
      expect(first.nextOffset).toBe(3)
      expect(
        yield* ReadToolFileSystem.exact(fs, file, "unicode.txt", {
          offset: 2,
          limit: 1,
          contentHash: first.contentHash,
        }).pipe(Effect.flip),
      ).toBeInstanceOf(ReadToolFileSystem.TextPageError)
      expect(
        yield* ReadToolFileSystem.exact(fs, file, "unicode.txt", {
          offset: 1,
          limit: 2,
          contentHash: first.contentHash,
        }),
      ).toMatchObject({ text: "😀", offset: 1, nextOffset: 3 })
      expect(
        yield* ReadToolFileSystem.exact(fs, file, "unicode.txt", { offset: 4, contentHash: first.contentHash }),
      ).toMatchObject({ text: "", offset: 4, nextOffset: null, complete: true })
      expect(
        yield* ReadToolFileSystem.exact(fs, file, "unicode.txt", { offset: 5, contentHash: first.contentHash }).pipe(
          Effect.flip,
        ),
      ).toBeInstanceOf(ReadToolFileSystem.OffsetOutOfRangeError)
      expect(
        yield* ReadToolFileSystem.exact(fs, file, "unicode.txt", {
          offset: 1,
          limit: 2,
          contentHash: "0".repeat(64),
        }).pipe(Effect.flip),
      ).toBeInstanceOf(ReadToolFileSystem.TextPageError)

      yield* files.writeFileString(file, "changed")
      expect(
        yield* ReadToolFileSystem.exact(fs, file, "unicode.txt", {
          offset: 3,
          contentHash: first.contentHash,
        }).pipe(Effect.flip),
      ).toBeInstanceOf(ReadToolFileSystem.TextPageError)
    }),
  )

  it.effect("rejects malformed UTF-8 on exact reads and preserves the legacy long-line recovery pointer", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const malformed = path.join(directory, "malformed-exact.txt")
      yield* files.writeFile(malformed, Uint8Array.of(0x61, 0xf0, 0x80, 0x80))

      expect(yield* ReadToolFileSystem.exact(fs, malformed, "malformed-exact.txt").pipe(Effect.flip)).toBeInstanceOf(
        ReadToolFileSystem.MalformedUtf8Error,
      )

      const longLine = path.join(directory, "long-line.txt")
      yield* files.writeFileString(longLine, `${"L".repeat(2_100)}\nsecond\n`)
      const result = yield* ReadToolFileSystem.read(fs, longLine, "long-line.txt", { limit: 1 })

      expect(result).toMatchObject({
        type: "text-page",
        truncated: true,
        lineTruncated: true,
        recovery: { textPage: {} },
      })
      if (result instanceof ReadToolFileSystem.TextPage) expect(result.next).toBe(2)

      const escaped = path.join(directory, "escaped.txt")
      yield* files.writeFileString(escaped, '"'.repeat(800))
      const budgetError = yield* ReadToolFileSystem.read(
        fs,
        escaped,
        "escaped.txt",
        {},
        { maxBytes: 1_200, maxLines: 1 },
      ).pipe(Effect.flip)
      expect(budgetError).toBeInstanceOf(ReadToolFileSystem.BudgetError)
    }),
  )

  it.effect("rejects a small-file read when the opened file grows beyond the normal-read bound", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "growing.txt")
      yield* files.writeFileString(file, "small")
      let originalInfo: FileSystem.File.Info | undefined
      const changing = FSUtil.Service.of({
        ...fs,
        open: (target, options) =>
          Effect.gen(function* () {
            if (target === file) {
              originalInfo = yield* fs.stat(target)
              yield* fs.writeFileString(target, "g".repeat(ReadToolFileSystem.MAX_READ_BYTES + 1))
            }
            const opened = yield* fs.open(target, options)
            const captured = originalInfo
            if (target !== file || captured === undefined) return opened
            return new Proxy(opened, {
              get: (handle, property) =>
                property === "stat" ? Effect.succeed(captured) : Reflect.get(handle, property, handle),
            })
          }),
      })

      const error = yield* ReadToolFileSystem.read(changing, file, "growing.txt").pipe(Effect.flip)

      expect(Number(originalInfo?.size)).toBe(5)
      expect(error).toBeInstanceOf(BoundedFile.SourceError)
      if (error instanceof BoundedFile.SourceError) expect(error.reason).toBe("changed")
    }),
  )

  it.effect("rejects an exact page when the current file changes during its streamed read", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "mutating-exact.txt")
      yield* files.writeFileString(file, "current")
      let streamReads = 0
      let mutated = false
      const changing = FSUtil.Service.of({
        ...fs,
        open: (target, options) =>
          Effect.flatMap(fs.open(target, options), (opened) =>
            Effect.succeed(
              new Proxy(opened, {
                get: (handle, property) => {
                  if (property !== "readAlloc") return Reflect.get(handle, property, handle)
                  return (size: number) =>
                    Effect.flatMap(opened.readAlloc(size), (chunk) => {
                      streamReads++
                      if (target !== file || streamReads !== 2 || mutated) return Effect.succeed(chunk)
                      mutated = true
                      return Effect.as(fs.writeFileString(target, "changed while streaming"), chunk)
                    })
                },
              }),
            ),
          ),
      })

      const error = yield* ReadToolFileSystem.exact(changing, file, "mutating-exact.txt").pipe(Effect.flip)

      expect(streamReads).toBe(2)
      expect(mutated).toBe(true)
      expect(error).toBeInstanceOf(BoundedFile.SourceError)
      if (error instanceof BoundedFile.SourceError) expect(error.reason).toBe("changed")
    }),
  )

  it.effect("does not invent a next line for a bounded partial read of a huge single line", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "single-line.txt")
      yield* files.writeFileString(file, "X".repeat(2 * 1024 * 1024))

      const result = yield* ReadToolFileSystem.read(fs, file, "single-line.txt", { limit: 1 })

      expect(result).toMatchObject({ type: "text-page", truncated: true, lineTruncated: true })
      if (result instanceof ReadToolFileSystem.TextPage) {
        expect(result.next).toBeUndefined()
        expect(result.content).toStartWith("X".repeat(2_000))
        expect(result.content.length).toBeLessThan(2_100)
      }
    }),
  )

  it.effect("pages after a skipped multi-chunk line and recovers an abbreviated surrogate-boundary line exactly", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "skipped-line.txt")
      const skipped = `${"S".repeat(64 * 1024 - 1)}\r\n`
      const selected = `${"A".repeat(1_999)}😀tail`
      const source = `${skipped}selected\r\n${selected}\r\nafter\r\n`
      yield* files.writeFileString(file, source)

      const page = yield* ReadToolFileSystem.read(fs, file, "skipped-line.txt", { offset: 2, limit: 2 })

      expect(page).toMatchObject({
        type: "text-page",
        offset: 2,
        content: `selected\n${"A".repeat(1_999)}... (line truncated to 2000 chars)`,
        truncated: true,
        next: 4,
        lineTruncated: true,
        recovery: { textPage: {} },
      })

      const snapshot = yield* ReadToolFileSystem.exact(fs, file, "skipped-line.txt", { limit: 1 })
      const exact = yield* ReadToolFileSystem.exact(fs, file, "skipped-line.txt", {
        offset: skipped.length + "selected\r\n".length,
        contentHash: snapshot.contentHash,
      })
      expect(exact.text).toBe(`${selected}\r\nafter\r\n`)
      expect(exact.complete).toBe(true)
      expect(exact.nextOffset).toBeNull()
    }),
  )

  it.effect("distinguishes an exact line-limit EOF from an additional line", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const atEof = path.join(directory, "at-eof.txt")
      const moreLines = path.join(directory, "more-lines.txt")
      yield* files.writeFileString(atEof, "one\r\ntwo\r\n")
      yield* files.writeFileString(moreLines, "one\r\ntwo\r\nthree\r\n")

      const eof = yield* ReadToolFileSystem.read(fs, atEof, "at-eof.txt", { limit: 2 })
      const next = yield* ReadToolFileSystem.read(fs, moreLines, "more-lines.txt", { limit: 2 })

      expect(eof).toMatchObject({ type: "text-page", content: "one\ntwo", offset: 1, truncated: false })
      if (eof instanceof ReadToolFileSystem.TextPage) expect(eof.next).toBeUndefined()
      expect(next).toMatchObject({ type: "text-page", content: "one\ntwo", offset: 1, truncated: true, next: 3 })
    }),
  )

  it.effect("keeps directory pages stable and rejects continuation after the visible snapshot changes", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      yield* files.writeFileString(path.join(directory, "b.txt"), "b")
      yield* files.writeFileString(path.join(directory, "a.txt"), "a")

      const first = yield* ReadToolFileSystem.list(fs, directory, { offset: 1, limit: 1 })
      expect(String(first.entries[0]?.path)).toBe("a.txt")
      expect(first.next).toBe(2)
      expect(first.snapshot).toMatch(/^[\da-f]{64}$/)
      const second = yield* ReadToolFileSystem.list(fs, directory, {
        offset: 2,
        limit: 1,
        snapshot: first.snapshot,
      })
      expect(String(second.entries[0]?.path)).toBe("b.txt")
      expect(second.truncated).toBe(false)

      yield* files.writeFileString(path.join(directory, "c.txt"), "c")
      expect(
        yield* ReadToolFileSystem.list(fs, directory, {
          offset: 2,
          limit: 1,
          snapshot: first.snapshot,
        }).pipe(Effect.flip),
      ).toBeInstanceOf(ReadToolFileSystem.SnapshotError)
    }),
  )

  it.effect("excludes directory symlinks that escape the requested directory", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const outside = yield* files.makeTempDirectoryScoped()
      yield* files.writeFileString(path.join(outside, "secret.txt"), "secret")
      yield* files.writeFileString(path.join(directory, "inside.txt"), "inside")
      yield* Effect.promise(() => promises.symlink(outside, path.join(directory, "outside-link"), "junction"))

      const result = yield* ReadToolFileSystem.list(fs, directory)

      expect(String(result.entries[0]?.path)).toBe("inside.txt")
      expect(result.entries).toHaveLength(1)
      expect(result.truncated).toBe(false)
    }),
  )

  it.effect("uses the bounded directory enumerator and returns its typed cap error", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      yield* files.writeFileString(path.join(directory, "one.txt"), "1")
      yield* files.writeFileString(path.join(directory, "two.txt"), "2")

      const error = yield* fs.readDirectoryEntriesBounded(directory, { maxEntries: 1 }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(FSUtil.DirectoryLimitError)
      expect(error).toMatchObject({ reason: "entries", maximum: 1 })
    }),
  )

  it.effect("returns a stable empty directory page at EOF", () =>
    Effect.gen(function* () {
      const { fs, directory } = yield* fixture

      const result = yield* ReadToolFileSystem.list(fs, directory)

      expect(result.entries).toEqual([])
      expect(result.truncated).toBe(false)
      expect(result.next).toBeUndefined()
      expect(result.snapshot).toMatch(/^[\da-f]{64}$/)
    }),
  )

  it.effect("returns an empty exact page for an empty text file", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "empty.txt")
      yield* files.writeFileString(file, "")

      const result = yield* ReadToolFileSystem.exact(fs, file, "empty.txt", {})

      expect(result).toMatchObject({
        text: "",
        offset: 0,
        nextOffset: null,
        totalLength: 0,
        complete: true,
        offsetUnit: "utf16_code_units",
      })
      expect(result.contentHash).toMatch(/^[\da-f]{64}$/)
    }),
  )

  it.effect("rejects a directory continuation snapshot from a different canonical root", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const other = yield* files.makeTempDirectoryScoped()
      for (const name of ["a.txt", "b.txt"]) {
        yield* files.writeFileString(path.join(directory, name), name)
        yield* files.writeFileString(path.join(other, name), name)
      }

      const first = yield* ReadToolFileSystem.list(fs, directory, { offset: 1, limit: 1 })
      const error = yield* ReadToolFileSystem.list(fs, other, {
        offset: 2,
        limit: 1,
        snapshot: first.snapshot,
      }).pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.SnapshotError)
    }),
  )

  it.effect("stops reading after the requested page is complete", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const prefix = new TextEncoder().encode("one\n")
      for (const [name, trailing] of [
        ["malformed.txt", 0x80],
        ["nul.txt", 0],
      ] as const) {
        const file = path.join(directory, name)
        yield* files.writeFile(file, Uint8Array.from([...prefix, trailing]))

        const result = yield* ReadToolFileSystem.read(fs, file, name, { limit: 1 })

        expect(result).toMatchObject({ type: "text-page", content: "one", truncated: true, next: 2 })
      }
    }),
  )

  it.effect("preserves the media ingestion limit message", () =>
    Effect.gen(function* () {
      const { fs, files, directory } = yield* fixture
      const file = path.join(directory, "oversized.png")
      yield* files.writeFile(file, Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
      yield* files.truncate(file, ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES + 1)

      const error = yield* ReadToolFileSystem.read(fs, file, "oversized.png").pipe(Effect.flip)

      expect(error).toBeInstanceOf(ReadToolFileSystem.MediaIngestLimitError)
      expect(error.message).toBe(
        `Media exceeds ${ReadToolFileSystem.MAX_MEDIA_INGEST_BYTES} byte ingestion limit: oversized.png`,
      )
    }),
  )
})
