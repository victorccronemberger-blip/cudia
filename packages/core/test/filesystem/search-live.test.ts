import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(Layer.empty)
const slash = (value: string) => value.replaceAll("\\", "/")
const withTmp = <A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (temp) => Effect.promise(() => temp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((temp) => f(temp.path)))

function provide(directory: string) {
  return Effect.provide(
    LayerNode.compile(FileSystemSearch.node, [
      [
        Location.node,
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
      ],
    ]),
  )
}

describe("filesystem live glob and grep", () => {
  it.live("returns complete initial results beyond native page defaults and honors explicit limits", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all(
            Array.from({ length: 173 }, (_, index) =>
              fs.writeFile(path.join(directory, `file-${String(index).padStart(3, "0")}.txt`), "needle\n"),
            ),
          ),
        )
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "many-lines.txt"), "needle\n".repeat(230)))
        yield* Effect.gen(function* () {
          const search = yield* FileSystemSearch.Service
          const files = yield* search.glob({ pattern: "**/*.txt" })
          expect(files).toHaveLength(174)
          expect(new Set(files.map((entry) => entry.path)).size).toBe(174)
          expect(yield* search.glob({ pattern: "**/*.txt", limit: 7 })).toHaveLength(7)
          const matches = yield* search.grep({ pattern: "needle" })
          expect(matches).toHaveLength(403)
          expect(matches.filter((match) => match.entry.path === "many-lines.txt")).toHaveLength(230)
          expect(yield* search.grep({ pattern: "needle", limit: 13 })).toHaveLength(13)
        }).pipe(provide(directory))
      }),
    ),
  )

  it.live("observes creation, content edits, renames and deletion in the same Location", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "initial.txt"), "before"))
        yield* Effect.gen(function* () {
          const search = yield* FileSystemSearch.Service
          expect(yield* search.grep({ pattern: "after" })).toEqual([])
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "initial.txt"), "after\n"))
          expect((yield* search.grep({ pattern: "after" })).map((match) => match.entry.path)).toEqual([
            RelativePath.make("initial.txt"),
          ])
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "fresh.txt"), "after\n"))
          expect(yield* search.glob({ pattern: "**/*.txt" })).toHaveLength(2)
          expect(yield* search.grep({ pattern: "after" })).toHaveLength(2)
          yield* Effect.promise(() => fs.rename(path.join(directory, "fresh.txt"), path.join(directory, "renamed.txt")))
          expect((yield* search.glob({ pattern: "**/*.txt" })).map((entry) => entry.path)).toContain(
            RelativePath.make("renamed.txt"),
          )
          yield* Effect.promise(() => fs.unlink(path.join(directory, "initial.txt")))
          expect((yield* search.grep({ pattern: "after" })).map((match) => match.entry.path)).toEqual([
            RelativePath.make("renamed.txt"),
          ])
        }).pipe(provide(directory))
      }),
    ),
  )

  it.live("keeps literal paths separate from glob filters and regex with spaces and metacharacters", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const selected = "ação [dir] space"
        yield* Effect.promise(() => fs.mkdir(path.join(directory, selected)))
        yield* Effect.promise(() =>
          fs.writeFile(path.join(directory, selected, "one [x].ts"), "é needle café\nNeedle\nliteral *.ts\n"),
        )
        yield* Effect.promise(() => fs.writeFile(path.join(directory, selected, "two.txt"), "needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "neighbor.ts"), "needle\n"))
        yield* Effect.gen(function* () {
          const search = yield* FileSystemSearch.Service
          const files = yield* search.glob({ pattern: "**/*.ts", path: RelativePath.make(selected) })
          expect(files.map((entry) => slash(entry.path))).toEqual([`${selected}/one [x].ts`])
          const matches = yield* search.grep({ pattern: "needle", path: RelativePath.make(selected), include: "*.ts" })
          expect(matches).toHaveLength(1)
          expect(slash(matches[0]!.entry.path)).toBe(`${selected}/one [x].ts`)
          expect(matches[0]).toMatchObject({ line: 1, offset: 0, submatches: [{ text: "needle", start: 3, end: 9 }] })
          const file = RelativePath.make(path.join(selected, "one [x].ts"))
          expect(yield* search.grep({ pattern: "needle|Needle", path: file })).toHaveLength(2)
          expect(yield* search.grep({ pattern: "\\*\\.ts", path: file })).toHaveLength(1)
          // Ripgrep deliberately gives an explicit file priority over globs.
          // Directory filters above still exclude two.txt and neighbor.ts.
          const explicit = yield* search.grep({ pattern: "needle", path: file, include: "*.txt" })
          expect(explicit).toHaveLength(1)
          expect(slash(explicit[0]!.entry.path)).toBe(`${selected}/one [x].ts`)
        }).pipe(provide(directory))
      }),
    ),
  )

  it.live("reports invalid regex and missing targets instead of returning plausible matches", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "neighbor.txt"), "needle [\n"))
        yield* Effect.gen(function* () {
          const search = yield* FileSystemSearch.Service
          const invalid = yield* search.grep({ pattern: "[" }).pipe(Effect.exit)
          expect(Exit.isFailure(invalid)).toBe(true)
          if (Exit.isFailure(invalid)) expect(Cause.prettyErrors(invalid.cause).join(" ")).toContain("regex")
          expect(
            Exit.isFailure(
              yield* search.grep({ pattern: "needle", path: RelativePath.make("missing.txt") }).pipe(Effect.exit),
            ),
          ).toBe(true)
          expect(
            Exit.isFailure(
              yield* search.glob({ pattern: "**/*", path: RelativePath.make("neighbor.txt") }).pipe(Effect.exit),
            ),
          ).toBe(true)
        }).pipe(provide(directory))
      }),
    ),
  )

  it.live("searches only the requested parent-relative, absolute or junction target outside the Location", () =>
    withTmp((parent) =>
      Effect.gen(function* () {
        const directory = path.join(parent, "active")
        const outside = path.join(parent, "outside")
        yield* Effect.promise(() => Promise.all([fs.mkdir(directory), fs.mkdir(outside)]))
        yield* Effect.promise(() => fs.writeFile(path.join(outside, "secret.txt"), "needle"))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "neighbor.txt"), "needle"))
        yield* Effect.promise(() =>
          fs.symlink(outside, path.join(directory, "escape"), process.platform === "win32" ? "junction" : "dir"),
        )
        yield* Effect.gen(function* () {
          const search = yield* FileSystemSearch.Service
          for (const target of ["../outside", outside, "escape"]) {
            const input = { path: RelativePath.make(target) }
            expect((yield* search.glob({ ...input, pattern: "**/*" })).map((entry) => slash(entry.path))).toEqual([
              "../outside/secret.txt",
            ])
            const matches = yield* search.grep({ ...input, pattern: "needle" })
            expect(matches).toHaveLength(1)
            expect(slash(matches[0]!.entry.path)).toBe("../outside/secret.txt")
            expect(matches[0]!.text).toBe("needle")
          }
          yield* Effect.promise(() => fs.writeFile(path.join(outside, "neighbor.txt"), "needle"))
          const exact = yield* search.grep({
            pattern: "needle",
            path: RelativePath.make("../outside/secret.txt"),
          })
          expect(exact).toHaveLength(1)
          expect(slash(exact[0]!.entry.path)).toBe("../outside/secret.txt")
        }).pipe(provide(directory))
      }),
    ),
  )
})
