import { describe, expect } from "bun:test"
import { Effect, FileSystem } from "effect"
import { join } from "path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Glob } from "@opencode-ai/core/util/glob"
import { testEffect } from "./lib/effect"

const live = LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.filesystem]))
const { effect: it } = testEffect(live)

describe("bounded filesystem discovery", () => {
  it(
    "fails with a typed error after acquiring one candidate beyond the glob result cap",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      yield* files.writeFileString(join(directory, "one.txt"), "1")
      yield* files.writeFileString(join(directory, "two.txt"), "2")

      expect(yield* fs.glob("*.txt", { cwd: directory, maxResults: 2 })).toHaveLength(2)
      expect(Glob.scanSync("*.txt", { cwd: directory, maxResults: 2 })).toHaveLength(2)
      yield* files.writeFileString(join(directory, "three.txt"), "3")

      const error = yield* fs.glob("*.txt", { cwd: directory, maxResults: 2 }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(FSUtil.DiscoveryLimitError)
      if (!(error instanceof FSUtil.DiscoveryLimitError)) throw error
      expect(error.maximumResults).toBe(2)
    }),
  )

  it(
    "allows zero results for an empty scan and fails on its first candidate",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()

      expect(yield* fs.glob("*.txt", { cwd: directory, maxResults: 0 })).toEqual([])
      yield* files.writeFileString(join(directory, "one.txt"), "1")
      const error = yield* fs.glob("*.txt", { cwd: directory, maxResults: 0 }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(FSUtil.DiscoveryLimitError)
      if (!(error instanceof FSUtil.DiscoveryLimitError)) throw error
      expect(error.maximumResults).toBe(0)
    }),
  )

  it(
    "relays cancellation while a bounded scan is waiting for its first result",
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      yield* files.writeFileString(join(directory, "one.txt"), "1")

      const controller = new AbortController()
      const scan = Glob.scan("*.txt", { cwd: directory, maxResults: 1 }, controller.signal)
      controller.abort(new Error("scan cancelled"))

      const result = yield* Effect.promise(() =>
        scan.then(
          () => ({ ok: true as const }),
          (error) => ({ ok: false as const, error }),
        ),
      )
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.error).toBeInstanceOf(Error)
    }),
  )

  it(
    "applies aggregate result caps across ancestor searches",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const files = yield* FileSystem.FileSystem
      const root = yield* files.makeTempDirectoryScoped()
      const nested = join(root, "a", "b")
      yield* files.makeDirectory(nested, { recursive: true })
      yield* files.writeFileString(join(nested, "AGENTS.md"), "near")
      yield* files.writeFileString(join(root, "AGENTS.md"), "far")
      yield* files.writeFileString(join(nested, "near.bounded.md"), "near")
      yield* files.writeFileString(join(root, "far.bounded.md"), "far")

      const upError = yield* fs
        .up({ targets: ["AGENTS.md"], start: nested, stop: root, maxResults: 1 })
        .pipe(Effect.flip)
      expect(upError).toBeInstanceOf(FSUtil.DiscoveryLimitError)
      if (!(upError instanceof FSUtil.DiscoveryLimitError)) throw upError
      expect(upError.maximumResults).toBe(1)

      const globError = yield* fs.globUp("*.bounded.md", nested, root, { maxResults: 1 }).pipe(Effect.flip)
      expect(globError).toBeInstanceOf(FSUtil.DiscoveryLimitError)
      if (!(globError instanceof FSUtil.DiscoveryLimitError)) throw globError
      expect(globError.maximumResults).toBe(1)
    }),
  )

  it(
    "observes the same instruction glob ordering through eager and bounded scans",
    Effect.gen(function* () {
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()
      const nested = join(directory, "nested")
      yield* files.makeDirectory(nested)
      yield* files.writeFileString(join(directory, "AGENTS.md"), "root")
      yield* files.writeFileString(join(directory, "AGENTS.local.md"), "local")
      yield* files.writeFileString(join(nested, "AGENTS.md"), "nested")

      const pattern = "**/AGENTS*.md"
      const eager = yield* Effect.promise(() => Glob.scan(pattern, { cwd: directory }))
      const bounded = yield* Effect.promise(() => Glob.scan(pattern, { cwd: directory, maxResults: 10 }))
      const repeated = yield* Effect.promise(() => Glob.scan(pattern, { cwd: directory, maxResults: 10 }))
      expect(bounded).toEqual(eager)
      expect(repeated).toEqual(bounded)
    }),
  )

  it(
    "rejects malformed limits instead of treating them as unbounded",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const files = yield* FileSystem.FileSystem
      const directory = yield* files.makeTempDirectoryScoped()

      const error = yield* fs.glob("*.txt", { cwd: directory, maxResults: Number.NaN }).pipe(Effect.flip)
      expect(error).toBeInstanceOf(FSUtil.FileSystemError)
      if (!(error instanceof FSUtil.FileSystemError)) throw error
      expect(error.method).toBe("glob")
    }),
  )
})
