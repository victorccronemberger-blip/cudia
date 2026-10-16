import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { RipgrepBinary } from "@opencode-ai/core/ripgrep/binary"
import { RelativePath } from "@opencode-ai/core/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const withTmp = <A, E, R>(f: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (temp) => Effect.promise(() => temp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((temp) => f(temp.path)))

describe("Ripgrep scan completeness", () => {
  it.live("rejects exit code 2 when completeness is required while preserving default partial results", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const binary = path.join(directory, process.platform === "win32" ? "rg.cmd" : "rg")
        const script =
          process.platform === "win32"
            ? "@echo off\r\necho partial.txt\r\n1>&2 echo fixture partial scan\r\nexit /b 2\r\n"
            : "#!/bin/sh\nprintf 'partial.txt\\n'\nprintf 'fixture partial scan\\n' >&2\nexit 2\n"
        yield* Effect.promise(() => fs.writeFile(binary, script))
        if (process.platform !== "win32") yield* Effect.promise(() => fs.chmod(binary, 0o755))

        const layer = LayerNode.compile(LayerNode.group([Ripgrep.node]), [
          [
            RipgrepBinary.node,
            Layer.succeed(RipgrepBinary.Service, RipgrepBinary.Service.of({ filepath: Effect.succeed(binary) })),
          ],
        ])
        yield* Effect.gen(function* () {
          const ripgrep = yield* Ripgrep.Service
          const partial = yield* ripgrep.find({ cwd: directory, pattern: "*", limit: 10 })
          expect(partial.map((item) => item.path)).toEqual([RelativePath.make("partial.txt")])

          const strict = yield* Effect.exit(
            ripgrep.find({ cwd: directory, pattern: "*", limit: 10, failOnPartial: true }),
          )
          expect(Exit.isFailure(strict)).toBe(true)
          if (Exit.isFailure(strict)) {
            expect(strict.cause.reasons.some((reason) => reason._tag === "Fail")).toBe(true)
            expect(String(strict.cause)).toContain("fixture partial scan")
          }
        }).pipe(Effect.provide(layer))
      }),
    ),
  )
})
