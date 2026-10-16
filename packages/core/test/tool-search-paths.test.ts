import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { GlobTool } from "@opencode-ai/core/tool/glob"
import { GrepTool } from "@opencode-ai/core/tool/grep"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const sessionID = SessionV2.ID.make("ses_search_paths")
const slash = (value: string) => value.replaceAll("\\", "/")

const withTmp = <A, E, R>(f: (directory: string, outside: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (temp) => Effect.promise(() => temp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((temp) =>
      Effect.gen(function* () {
        const directory = path.join(temp.path, "active")
        const outside = path.join(temp.path, "outside")
        yield* Effect.promise(() => Promise.all([fs.mkdir(directory), fs.mkdir(outside)]))
        return yield* f(directory, outside)
      }),
    ),
  )

function withTools<A, E, R>(
  directory: string,
  f: (context: {
    registry: ToolRegistry.Interface
    assertions: PermissionV2.AssertInput[]
    searches: string[]
  }) => Effect.Effect<A, E, R>,
  options: {
    deny?: string
    afterPermission?: (input: PermissionV2.AssertInput) => Effect.Effect<void>
  } = {},
) {
  const assertions: PermissionV2.AssertInput[] = []
  const searches: string[] = []
  const permission = Layer.succeed(
    PermissionV2.Service,
    PermissionV2.Service.of({
      check: () => Effect.die("unused"),
      assert: (input) =>
        Effect.sync(() => assertions.push(input)).pipe(
          Effect.andThen(() => options.afterPermission?.(input) ?? Effect.void),
          Effect.andThen(() =>
            input.action === options.deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void,
          ),
        ),
      ask: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      forSession: () => Effect.die("unused"),
      list: () => Effect.die("unused"),
    }),
  )
  const observedSearch = Layer.effect(
    Ripgrep.Service,
    Effect.gen(function* () {
      const real = yield* Ripgrep.Service
      return Ripgrep.Service.of({
        ...real,
        glob: (input) => Effect.sync(() => searches.push("glob")).pipe(Effect.andThen(real.glob(input))),
        grep: (input) => Effect.sync(() => searches.push("grep")).pipe(Effect.andThen(real.grep(input))),
      })
    }),
  ).pipe(Layer.provide(LayerNode.compile(Ripgrep.node)))
  return Effect.gen(function* () {
    return yield* f({ registry: yield* ToolRegistry.Service, assertions, searches })
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, GlobTool.node, GrepTool.node]), [
        [
          Location.node,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ],
        [PermissionV2.node, permission],
        [Ripgrep.node, observedSearch],
        [Config.node, Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ]),
    ),
  )
}

const call = (name: "glob" | "grep", input: { pattern: string; path?: string; include?: string; limit?: number }) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id: `call-${name}`, name, input },
})

describe("search target paths", () => {
  it.live("does not broaden a missing grep target to its parent directory", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "private-neighbor.txt"), "needle"))
        yield* withTools(directory, ({ registry, searches }) =>
          Effect.gen(function* () {
            const result = yield* settleTool(registry, call("grep", { pattern: "needle", path: "missing.txt" }))
            expect(result.result.type).toBe("error")
            expect(searches).toEqual([])
          }),
        )
      }),
    ),
  )

  it.live("keeps file grep exact and supports literal spaces, brackets and Unicode", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.mkdir(path.join(directory, "ação [dir]")))
        const target = path.join("ação [dir]", "one file [x].txt")
        yield* Effect.promise(() => fs.writeFile(path.join(directory, target), "é needle café\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "neighbor.txt"), "needle"))
        yield* withTools(directory, ({ registry, assertions }) =>
          Effect.gen(function* () {
            const result = yield* settleTool(
              registry,
              call("grep", { pattern: "needle", path: target, include: "*.ts" }),
            )
            expect(result.output?.structured).toMatchObject([
              { entry: { path: target }, line: 1, offset: 0, submatches: [{ text: "needle", start: 3, end: 9 }] },
            ])
            expect(assertions.map((item) => item.action)).toEqual(["grep"])
          }),
        )
      }),
    ),
  )

  it.live("keeps an authorized absolute output file searchable without including its neighbors", () =>
    withTmp((directory, outside) =>
      Effect.gen(function* () {
        const file = path.join(outside, "tool-output.txt")
        yield* Effect.promise(() => fs.writeFile(file, "retained needle\n"))
        yield* Effect.promise(() => fs.writeFile(path.join(outside, "neighbor.txt"), "needle"))
        yield* withTools(directory, ({ registry, assertions }) =>
          Effect.gen(function* () {
            const result = yield* settleTool(registry, call("grep", { pattern: "needle", path: file }))
            expect(result.output?.structured).toMatchObject([{ entry: { path: path.relative(directory, file) } }])
            expect(result.output?.structured).toHaveLength(1)
            expect(assertions.map((item) => item.action)).toEqual(["external_directory", "grep"])
          }),
        )
      }),
    ),
  )

  it.live("rejects a file supplied as a glob directory", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "file.txt"), "needle"))
        yield* withTools(directory, ({ registry, searches }) =>
          Effect.gen(function* () {
            const result = yield* settleTool(registry, call("glob", { pattern: "**/*", path: "file.txt" }))
            expect(result.result).toMatchObject({ type: "error", value: expect.stringContaining("not a directory") })
            expect(searches).toEqual([])
          }),
        )
      }),
    ),
  )

  it.live("reports an invalid regex instead of searching for literal brackets", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "brackets.txt"), "literal ["))
        yield* withTools(directory, ({ registry }) =>
          Effect.gen(function* () {
            const result = yield* settleTool(registry, call("grep", { pattern: "[" }))
            expect(result.result).toMatchObject({ type: "error", value: expect.stringContaining("regex") })
          }),
        )
      }),
    ),
  )

  it.live("does not broaden a file search when the target turns into a directory during approval", () =>
    withTmp((directory) =>
      Effect.gen(function* () {
        const file = path.join(directory, "selected.txt")
        yield* Effect.promise(() => fs.writeFile(file, "needle"))
        yield* withTools(
          directory,
          ({ registry, searches }) =>
            Effect.gen(function* () {
              const result = yield* settleTool(registry, call("grep", { pattern: "needle", path: "selected.txt" }))
              expect(result.result).toMatchObject({ type: "error", value: expect.stringContaining("changed") })
              expect(searches).toEqual([])
            }),
          {
            afterPermission: (input) =>
              input.action !== "grep"
                ? Effect.void
                : Effect.promise(async () => {
                    await fs.unlink(file)
                    await fs.mkdir(file)
                    await fs.writeFile(path.join(file, "new-child.txt"), "needle")
                  }),
          },
        )
      }),
    ),
  )

  for (const name of ["glob", "grep"] as const) {
    it.live(`${name} communicates its result limit without claiming that more results exist`, () =>
      withTmp((directory) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Promise.all(["one.txt", "two.txt"].map((file) => fs.writeFile(path.join(directory, file), "needle"))),
          )
          yield* withTools(directory, ({ registry }) =>
            Effect.gen(function* () {
              const result = yield* settleTool(
                registry,
                call(name, { pattern: name === "glob" ? "**/*" : "needle", limit: 1 }),
              )
              expect(result.output?.structured).toHaveLength(1)
              expect(result.result).toMatchObject({
                type: "text",
                value: expect.stringMatching(/Result limit reached \(1\)[\s\S]*check for more/),
              })
            }),
          )
        }),
      ),
    )

    it.live(`${name} authorizes the real directory behind an explicit external alias`, () =>
      withTmp((directory, outside) =>
        Effect.gen(function* () {
          const actual = path.join(outside, "real")
          const alias = path.join(outside, "alias")
          yield* Effect.promise(() => fs.mkdir(actual))
          yield* Effect.promise(() => fs.writeFile(path.join(actual, "selected.txt"), "needle"))
          yield* Effect.promise(() => fs.symlink(actual, alias, process.platform === "win32" ? "junction" : "dir"))
          yield* withTools(directory, ({ registry, assertions, searches }) =>
            Effect.gen(function* () {
              const result = yield* settleTool(
                registry,
                call(name, {
                  pattern: name === "glob" ? "**/*" : "needle",
                  path: name === "glob" ? alias : path.join(alias, "selected.txt"),
                }),
              )
              expect(result.result.type).not.toBe("error")
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", name])
              expect(assertions[0]?.resources).toEqual([slash(path.join(actual, "*"))])
              expect(searches).toEqual([name])
            }),
          )
        }),
      ),
    )

    it.live(`${name} searches an internal directory alias using its canonical external target`, () =>
      withTmp((directory, outside) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(outside, "secret.txt"), "needle"))
          yield* Effect.promise(() =>
            fs.symlink(outside, path.join(directory, "escape"), process.platform === "win32" ? "junction" : "dir"),
          )
          yield* withTools(directory, ({ registry, assertions, searches }) =>
            Effect.gen(function* () {
              const result = yield* settleTool(
                registry,
                call(name, { pattern: name === "glob" ? "**/*" : "needle", path: "escape" }),
              )
              expect(result.result.type).not.toBe("error")
              expect(result.output?.structured).toHaveLength(1)
              expect(result.output?.structured).toMatchObject(
                name === "glob"
                  ? [{ path: path.relative(directory, path.join(outside, "secret.txt")) }]
                  : [{ entry: { path: path.relative(directory, path.join(outside, "secret.txt")) }, text: "needle" }],
              )
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", name])
              expect(assertions[0]?.resources).toEqual([slash(path.join(outside, "*"))])
              expect(assertions[1]?.metadata).toMatchObject({ root: slash(outside), path: "escape" })
              expect(searches).toEqual([name])
            }),
          )
        }),
      ),
    )

    it.live(`${name} revalidates the target after approval changes an internal directory into an external alias`, () =>
      withTmp((directory, outside) =>
        Effect.gen(function* () {
          const selected = path.join(directory, "selected")
          yield* Effect.promise(() => fs.mkdir(selected))
          yield* Effect.promise(() => fs.writeFile(path.join(outside, "secret.txt"), "needle"))
          yield* withTools(
            directory,
            ({ registry, assertions, searches }) =>
              Effect.gen(function* () {
                const result = yield* settleTool(
                  registry,
                  call(name, { pattern: name === "glob" ? "**/*" : "needle", path: "selected" }),
                )
                expect(result.result.type).toBe("error")
                expect(searches).toEqual([])
                expect(assertions.map((item) => item.action)).toEqual([name])
              }),
            {
              afterPermission: (input) =>
                input.action !== name
                  ? Effect.void
                  : Effect.promise(async () => {
                      await fs.rmdir(selected)
                      await fs.symlink(outside, selected, process.platform === "win32" ? "junction" : "dir")
                    }),
            },
          )
        }),
      ),
    )

    it.live(`${name} searches a parent-relative directory using its canonical external target`, () =>
      withTmp((directory, outside) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(outside, "secret.txt"), "needle"))
          yield* withTools(directory, ({ registry, assertions, searches }) =>
            Effect.gen(function* () {
              const result = yield* settleTool(
                registry,
                call(name, { pattern: name === "glob" ? "**/*" : "needle", path: "../outside" }),
              )
              expect(result.result.type).not.toBe("error")
              expect(result.output?.structured).toHaveLength(1)
              expect(result.output?.structured).toMatchObject(
                name === "glob"
                  ? [{ path: path.relative(directory, path.join(outside, "secret.txt")) }]
                  : [{ entry: { path: path.relative(directory, path.join(outside, "secret.txt")) }, text: "needle" }],
              )
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", name])
              expect(assertions[0]?.resources).toEqual([slash(path.join(outside, "*"))])
              expect(assertions[1]?.metadata).toMatchObject({ root: slash(outside), path: "../outside" })
              expect(searches).toEqual([name])
            }),
          )
        }),
      ),
    )

    it.live(`${name} authorizes external directories before its operation`, () =>
      withTmp((directory, outside) =>
        Effect.gen(function* () {
          yield* Effect.promise(() => fs.writeFile(path.join(outside, "external.txt"), "needle"))
          yield* withTools(directory, ({ registry, assertions, searches }) =>
            Effect.gen(function* () {
              const result = yield* settleTool(
                registry,
                call(name, { pattern: name === "glob" ? "**/*" : "needle", path: outside }),
              )
              expect(result.result.type).not.toBe("error")
              expect(assertions.map((item) => item.action)).toEqual(["external_directory", name])
              expect(assertions[0]?.resources).toEqual([slash(path.join(outside, "*"))])
              expect(assertions[1]?.source).toEqual({
                type: "tool",
                messageID: toolIdentity.assistantMessageID,
                callID: `call-${name}`,
              })
              expect(searches).toEqual([name])
            }),
          )
        }),
      ),
    )

    for (const deny of ["external_directory", name]) {
      it.live(`${name} does not search after ${deny} denial`, () =>
        withTmp((directory, outside) =>
          withTools(
            directory,
            ({ registry, assertions, searches }) =>
              Effect.gen(function* () {
                const result = yield* settleTool(
                  registry,
                  call(name, { pattern: name === "glob" ? "**/*" : "needle", path: outside }),
                )
                expect(result.result.type).toBe("error")
                expect(searches).toEqual([])
                expect(assertions.map((item) => item.action)).toEqual(
                  deny === "external_directory" ? ["external_directory"] : ["external_directory", name],
                )
              }),
            { deny },
          ),
        ),
      )
    }
  }
})
