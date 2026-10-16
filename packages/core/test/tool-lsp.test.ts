import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LSPV2 } from "@opencode-ai/core/lsp"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { LSPTool } from "@opencode-ai/core/tool/lsp"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolDefinitions, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const sessionID = SessionV2.ID.make("ses_lsp_tool")
const call = (filePath: string, line = 1, character = 1, operation: LSPV2.Operation | "diagnostics" = "hover") => ({
  sessionID,
  ...toolIdentity,
  call: {
    type: "tool-call" as const,
    id: "call-lsp",
    name: "lsp",
    input: { operation, filePath, line, character },
  },
})

const withTemp = <A, E, R>(f: (directory: string, outside: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (temp) => Effect.promise(() => temp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((temp) =>
      Effect.gen(function* () {
        const directory = path.join(temp.path, "active")
        const outside = path.join(temp.path, "outside.ts")
        yield* Effect.promise(() => fs.mkdir(directory))
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "one.ts"), "const value = 1\n"))
        yield* Effect.promise(() => fs.writeFile(outside, "const privateValue = 2\n"))
        return yield* f(directory, outside)
      }),
    ),
  )

function withTool<A, E, R>(
  directory: string,
  f: (input: {
    registry: ToolRegistry.Interface
    queries: LSPV2.Query[]
    assertions: PermissionV2.AssertInput[]
  }) => Effect.Effect<A, E, R>,
  options: {
    setting?: Config.Info["lsp"]
    deny?: boolean
    denyResource?: string
    afterPermission?: () => Effect.Effect<unknown>
  } = { setting: true },
) {
  const queries: LSPV2.Query[] = []
  const assertions: PermissionV2.AssertInput[] = []
  return Effect.gen(function* () {
    return yield* f({ registry: yield* ToolRegistry.Service, queries, assertions })
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, LSPTool.node]), [
        [
          Location.node,
          Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
        ],
        [
          Config.node,
          Layer.succeed(
            Config.Service,
            Config.Service.of({
              entries: () =>
                Effect.succeed([
                  new Config.Document({ type: "document", info: new Config.Info({ lsp: options.setting }) }),
                ]),
            }),
          ),
        ],
        [
          LSPV2.node,
          Layer.succeed(
            LSPV2.Service,
            LSPV2.Service.of({
              supports: () => Effect.succeed(true),
              diagnostics: ({ filePath }) =>
                Effect.succeed({
                  server: "fixture",
                  filePath,
                  version: 1,
                  generation: 1,
                  source: "pull" as const,
                  freshness: "current" as const,
                  diagnostics: [],
                  omitted: 0,
                }),
              forget: () => Effect.void,
              didClose: () => Effect.void,
              status: () => Effect.succeed([]),
              query: (input) =>
                Effect.sync(() => {
                  queries.push(input)
                  return { server: "fixture", result: { contents: "hover result" }, omitted: 0 }
                }),
            }),
          ),
        ],
        [
          PermissionV2.node,
          Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              check: () => Effect.die("unused"),
              assert: (input) =>
                Effect.sync(() => assertions.push(input)).pipe(
                  Effect.andThen(() => options.afterPermission?.() ?? Effect.void),
                  Effect.andThen(() =>
                    options.deny ||
                    (options.denyResource !== undefined && input.resources.includes(options.denyResource))
                      ? Effect.fail(new PermissionV2.BlockedError({ rules: [] }))
                      : Effect.void,
                  ),
                ),
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
            }),
          ),
        ],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ]),
    ),
  )
}

describe("native LSP tool authorization", () => {
  it.live("routes explicit diagnostics through the same file authorization", () =>
    withTemp((directory) =>
      withTool(directory, ({ registry, assertions, queries }) =>
        Effect.gen(function* () {
          const result = yield* settleTool(registry, call("one.ts", 1, 1, "diagnostics"))
          expect(result.result.type).not.toBe("error")
          expect(result.output?.structured).toMatchObject({
            server: "fixture",
            result: { freshness: "current", source: "pull", diagnostics: [] },
          })
          expect(assertions.map((item) => item.action)).toEqual(["lsp"])
          expect(queries).toEqual([])
        }),
      ),
    ),
  )
  for (const setting of [undefined, false, {}] as const)
    it.live(`omits LSP from definitions for ${JSON.stringify(setting)}`, () =>
      withTemp((directory) =>
        withTool(
          directory,
          ({ registry, queries }) =>
            Effect.gen(function* () {
              expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).not.toContain("lsp")
              expect(queries).toEqual([])
            }),
          { setting },
        ),
      ),
    )

  it.live("authorizes before querying and converts 1-based UTF-16 positions", () =>
    withTemp((directory) =>
      withTool(directory, ({ registry, queries, assertions }) =>
        Effect.gen(function* () {
          const output = yield* settleTool(registry, call("one.ts", 3, 5))
          expect(output.result.type).not.toBe("error")
          expect(queries).toEqual([
            { operation: "hover", filePath: path.join(directory, "one.ts"), line: 2, character: 4 },
          ])
          expect(assertions).toHaveLength(1)
          expect(assertions[0]).toMatchObject({
            action: "lsp",
            resources: ["one.ts"],
            sessionID,
            source: { type: "tool", messageID: toolIdentity.assistantMessageID, callID: "call-lsp" },
          })
        }),
      ),
    ),
  )

  it.live("denial prevents sending document content or starting a server", () =>
    withTemp((directory) =>
      withTool(
        directory,
        ({ registry, queries, assertions }) =>
          Effect.gen(function* () {
            expect((yield* settleTool(registry, call("one.ts"))).result.type).toBe("error")
            expect(assertions.map((item) => item.action)).toEqual(["lsp"])
            expect(queries).toEqual([])
          }),
        { setting: true, deny: true },
      ),
    ),
  )

  it.live("keeps LSP visible despite legacy candidate deny records", () =>
    withTemp((directory) =>
      withTool(directory, ({ registry, queries }) =>
        Effect.gen(function* () {
          const definitions = yield* toolDefinitions(registry, [
            { action: "*", resource: "*", effect: "deny" },
            { action: "read", resource: "*", effect: "allow" },
            { action: "glob", resource: "*", effect: "allow" },
            { action: "grep", resource: "*", effect: "allow" },
            { action: "webfetch", resource: "*", effect: "allow" },
            { action: "skill", resource: "*", effect: "allow" },
          ])
          expect(definitions.map((tool) => tool.name)).toContain("lsp")
          expect(queries).toEqual([])
        }),
      ),
    ),
  )

  for (const denyResource of [".", "one.ts"])
    it.live(`authorizes both workspace and admitted document for symbols; denies ${denyResource}`, () =>
      withTemp((directory) =>
        withTool(
          directory,
          ({ registry, queries, assertions }) =>
            Effect.gen(function* () {
              const result = yield* settleTool(registry, call("one.ts", 1, 1, "workspaceSymbol"))
              expect(result.result.type).toBe("error")
              expect(queries).toEqual([])
              expect(assertions[0]).toMatchObject({
                resources: ["one.ts", "."],
                metadata: { scope: "workspace", operation: "workspaceSymbol" },
              })
            }),
          { setting: true, denyResource },
        ),
      ),
    )

  it.live("queries an explicitly supplied external file through the configured server", () =>
    withTemp((directory, outside) =>
      withTool(directory, ({ registry, queries, assertions }) =>
        Effect.gen(function* () {
          expect((yield* settleTool(registry, call(outside))).result.type).not.toBe("error")
          expect(queries[0]?.filePath).toBe(yield* Effect.promise(() => fs.realpath(outside)))
          expect(assertions.map((input) => input.action)).toEqual(["lsp"])
        }),
      ),
    ),
  )

  it.live("does not query a file replaced by a directory during approval", () =>
    withTemp((directory) =>
      withTool(
        directory,
        ({ registry, queries }) =>
          Effect.gen(function* () {
            expect((yield* settleTool(registry, call("one.ts"))).result.type).toBe("error")
            expect(queries).toEqual([])
          }),
        {
          setting: true,
          afterPermission: () =>
            Effect.promise(async () => {
              await fs.unlink(path.join(directory, "one.ts"))
              await fs.mkdir(path.join(directory, "one.ts"))
            }),
        },
      ),
    ),
  )

  it.live("rejects invalid positions before authorization", () =>
    withTemp((directory) =>
      withTool(directory, ({ registry, queries, assertions }) =>
        Effect.gen(function* () {
          expect((yield* settleTool(registry, call("one.ts", 0))).result.type).toBe("error")
          expect((yield* settleTool(registry, call("one.ts", 1, -1))).result.type).toBe("error")
          expect(queries).toEqual([])
          expect(assertions).toEqual([])
        }),
      ),
    ),
  )
})
