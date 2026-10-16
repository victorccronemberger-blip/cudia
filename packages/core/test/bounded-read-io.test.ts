import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, FileSystem } from "effect"
import { resolve } from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { BoundedFile } from "@opencode-ai/core/util/bounded-file"
import { testEffect } from "./lib/effect"

const live = LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem]))
const { effect: it } = testEffect(live)

describe("bounded filesystem reads", () => {
  it(
    "scans directory entries within the entry and metadata byte caps",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      yield* files.writeFileString(`${directory}/alpha`, "a")
      yield* files.writeFileString(`${directory}/βeta`, "b")

      expect(
        (yield* fs.readDirectoryEntriesBounded(directory, { maxEntries: 2 })).map((entry) => entry.name),
      ).toHaveLength(2)
      const entriesLimit = yield* fs.readDirectoryEntriesBounded(directory, { maxEntries: 1 }).pipe(Effect.flip)
      expect(entriesLimit).toBeInstanceOf(FSUtil.DirectoryLimitError)
      if (!(entriesLimit instanceof FSUtil.DirectoryLimitError)) throw entriesLimit
      expect(entriesLimit.reason).toBe("entries")

      const bytesLimit = yield* fs.readDirectoryEntriesBounded(directory, { maxBytes: 1 }).pipe(Effect.flip)
      expect(bytesLimit).toBeInstanceOf(FSUtil.DirectoryLimitError)
      if (!(bytesLimit instanceof FSUtil.DirectoryLimitError)) throw bytesLimit
      expect(bytesLimit.reason).toBe("bytes")

      const invalidLimit = yield* fs
        .readDirectoryEntriesBounded(directory, { maxEntries: Number.POSITIVE_INFINITY })
        .pipe(Effect.flip)
      expect(invalidLimit).toBeInstanceOf(FSUtil.FileSystemError)
      if (!(invalidLimit instanceof FSUtil.FileSystemError)) throw invalidLimit
      expect(invalidLimit.method).toBe("readDirectoryEntriesBounded")
    }),
  )

  it(
    "reads actual file bytes and rejects a file above the byte cap",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      const path = resolve(`${directory}/text.txt`)
      yield* files.writeFile(path, new TextEncoder().encode("hello"))

      expect(new TextDecoder().decode(yield* BoundedFile.read(fs, path, 5))).toBe("hello")
      const limit = yield* BoundedFile.read(fs, path, 4).pipe(Effect.flip)
      expect(limit).toBeInstanceOf(BoundedFile.LimitError)
      if (!(limit instanceof BoundedFile.LimitError)) throw limit
      expect(limit.maximumBytes).toBe(4)
    }),
  )

  it(
    "rejects directories and invalid byte limits with typed source errors",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()

      const nonFile = yield* BoundedFile.read(fs, directory, 10).pipe(Effect.flip)
      expect(nonFile).toBeInstanceOf(BoundedFile.SourceError)
      if (!(nonFile instanceof BoundedFile.SourceError)) throw nonFile
      expect(nonFile.reason).toBe("not_file")

      const invalid = yield* BoundedFile.read(fs, `${directory}/missing`, -1).pipe(Effect.flip)
      expect(invalid).toBeInstanceOf(BoundedFile.SourceError)
      if (!(invalid instanceof BoundedFile.SourceError)) throw invalid
      expect(invalid.reason).toBe("range")
    }),
  )

  it(
    "enforces the byte cap when a file grows after its initial stat",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      const path = resolve(`${directory}/text.txt`)
      yield* files.writeFileString(path, "small")
      let originalInfo: FileSystem.File.Info | undefined
      const changing = FSUtil.Service.of({
        ...fs,
        open: (target, options) =>
          Effect.gen(function* () {
            if (target === path) {
              originalInfo = yield* fs.stat(target)
              yield* fs.writeFileString(target, "changed after stat")
            }
            const file = yield* fs.open(target, options)
            if (target !== path) return file
            return new Proxy(file, {
              get: (target, property) =>
                property === "stat" && originalInfo
                  ? Effect.succeed(originalInfo)
                  : Reflect.get(target, property, target),
            })
          }),
      })

      const result = yield* BoundedFile.read(changing, path, 5).pipe(Effect.flip)
      expect(result).toBeInstanceOf(BoundedFile.LimitError)
      if (!(result instanceof BoundedFile.LimitError)) throw result
      expect(result.maximumBytes).toBe(5)
    }),
  )

  it(
    "rejects a source that mutates during an otherwise bounded read",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      const path = resolve(`${directory}/text.txt`)
      yield* files.writeFileString(path, "before")
      let mutated = false
      const changing = FSUtil.Service.of({
        ...fs,
        open: (target, options) =>
          Effect.flatMap(fs.open(target, options), (file) =>
            Effect.acquireRelease(
              Effect.succeed(
                new Proxy(file, {
                  get: (handle, property) => {
                    if (property !== "readAlloc") return Reflect.get(handle, property, handle)
                    return (size: number) =>
                      Effect.flatMap(file.readAlloc(size), (chunk) =>
                        !mutated
                          ? Effect.sync(() => (mutated = true)).pipe(
                              Effect.andThen(fs.writeFileString(path, "changed while reading")),
                              Effect.as(chunk),
                            )
                          : Effect.succeed(chunk),
                      )
                  },
                }),
              ),
              () => Effect.void,
            ),
          ),
      })

      const error = yield* BoundedFile.read(changing, path, 100).pipe(Effect.flip)
      expect(error).toBeInstanceOf(BoundedFile.SourceError)
      if (!(error instanceof BoundedFile.SourceError)) throw error
      expect(error.reason).toBe("changed")
    }),
  )

  it(
    "releases an opened scoped handle when a bounded read is interrupted",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      const path = resolve(`${directory}/text.txt`)
      yield* files.writeFileString(path, "content")
      const started = yield* Deferred.make<void>()
      let opened = 0
      let released = 0
      const tracked = FSUtil.Service.of({
        ...fs,
        open: (target, options) =>
          Effect.flatMap(fs.open(target, options), (file) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                opened++
                return new Proxy(file, {
                  get: (handle, property) =>
                    property === "readAlloc"
                      ? () => Effect.andThen(Deferred.succeed(started, undefined), Effect.never)
                      : Reflect.get(handle, property, handle),
                })
              }),
              () => Effect.sync(() => released++),
            ),
          ),
      })

      const reading = yield* BoundedFile.read(tracked, path, 100).pipe(Effect.forkScoped)
      yield* Deferred.await(started)
      yield* Fiber.interrupt(reading)
      expect(opened).toBe(1)
      expect(released).toBe(1)
    }),
  )
})
