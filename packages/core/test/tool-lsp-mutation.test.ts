import fs from "node:fs/promises"
import path from "node:path"
import { describe, expect } from "bun:test"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LSPV2 } from "@opencode-ai/core/lsp"
import { LSPMutation } from "@opencode-ai/core/lsp/mutation"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { ApplyPatchTool } from "@opencode-ai/core/tool/apply-patch"
import { EditTool } from "@opencode-ai/core/tool/edit"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { WriteTool } from "@opencode-ai/core/tool/write"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const it = testEffect(Layer.empty)
const sessionID = SessionV2.ID.make("ses_post_write_lsp_test")
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    check: () => Effect.succeed("allow"),
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const call = (name: string, input: unknown, id = `call-${name}`) => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, name, input, id },
})

const report = (filePath: string): LSPV2.DiagnosticResult => ({
  filePath,
  server: "fixture",
  source: "push",
  freshness: "unversioned",
  version: 1,
  generation: 1,
  diagnostics: [],
  omitted: 0,
})

function fixture(diagnostics: LSPV2.Interface["diagnostics"] = ({ filePath }) => Effect.succeed(report(filePath))) {
  const forgotten: LSPMutation.Change[] = []
  const queried: string[] = []
  const closed: string[] = []
  const lsp = LSPV2.Service.of({
    supports: ({ filePath }) => Effect.succeed(path.extname(filePath) === ".ts"),
    forget: (input) =>
      Effect.sync(() => {
        forgotten.push(input)
      }),
    didClose: ({ filePath }) =>
      Effect.sync(() => {
        closed.push(filePath)
      }),
    diagnostics: (input) =>
      Effect.sync(() => {
        queried.push(input.filePath)
      }).pipe(Effect.andThen(() => diagnostics(input))),
    query: () => Effect.die("unused"),
    status: () => Effect.succeed([]),
  })
  return { lsp, forgotten, queried, closed }
}

function withTools<A, E, R>(
  directory: string,
  lsp: LSPV2.Interface,
  body: (registry: ToolRegistry.Interface) => Effect.Effect<A, E, R>,
  options: { enabled?: boolean; timeout?: number } = {},
) {
  return Effect.gen(function* () {
    return yield* body(yield* ToolRegistry.Service)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          WriteTool.node,
          EditTool.node,
          ApplyPatchTool.node,
        ]),
        [
          [
            Location.node,
            Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(directory) }))),
          ],
          [PermissionV2.node, permission],
          [
            LSPMutation.node,
            Layer.succeed(
              LSPMutation.Service,
              LSPMutation.make({ lsp, enabled: options.enabled ?? true, timeout: options.timeout }),
            ),
          ],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )
}

const withTemp = <A, E, R>(body: (directory: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (temp) => body(temp.path),
    (temp) => Effect.promise(() => temp[Symbol.asyncDispose]()),
  )

describe("mutation tools with LSP follow-up", () => {
  it.live("reports the saved file after write and exact edit, preserving unversioned freshness", () =>
    withTemp((directory) => {
      const observed: string[] = []
      const input = fixture(({ filePath }) =>
        Effect.promise(async () => {
          const text = await fs.readFile(filePath, "utf8")
          observed.push(text)
          return {
            ...report(filePath),
            diagnostics: text.includes('"bad"')
              ? [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                    message: "Type mismatch from fixture",
                    code: 2322,
                    severity: 1,
                  },
                ]
              : [],
          }
        }),
      )
      return withTools(directory, input.lsp, (registry) =>
        Effect.gen(function* () {
          const written = yield* settleTool(
            registry,
            call("write", { path: "file.ts", content: 'const value: number = "bad"\n' }),
          )
          expect(written.result).toMatchObject({
            type: "text",
            value: expect.stringContaining("Created file successfully: file.ts"),
          })
          expect(written.output?.structured).toMatchObject({
            lsp: {
              timedOut: false,
              files: [{ state: "reported", freshness: "unversioned", diagnostics: [{ code: 2322 }] }],
            },
          })
          const edited = yield* settleTool(
            registry,
            call("edit", { path: "file.ts", oldString: '"bad"', newString: "1" }),
          )
          expect(edited.result).toMatchObject({
            type: "text",
            value: expect.stringContaining("Edited file successfully: file.ts"),
          })
          expect(edited.output?.structured).toMatchObject({
            lsp: { files: [{ state: "reported", freshness: "unversioned", diagnostics: [] }] },
          })
          expect(observed).toEqual(['const value: number = "bad"\n', "const value: number = 1\n"])
          expect(input.forgotten).toEqual([
            { filePath: path.join(directory, "file.ts"), kind: "changed" },
            { filePath: path.join(directory, "file.ts"), kind: "changed" },
          ])
        }),
      )
    }),
  )

  it.live("collects only committed patch targets, and closes deleted files without requesting diagnostics", () =>
    withTemp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          Promise.all([
            fs.writeFile(path.join(directory, "update.ts"), "before\n"),
            fs.writeFile(path.join(directory, "remove.ts"), "removed\n"),
          ]),
        )
        const input = fixture(({ filePath }) =>
          Effect.promise(async () => {
            expect(await fs.readFile(filePath, "utf8")).toBe(filePath.endsWith("add.ts") ? "added\n" : "after\n")
            expect(input.forgotten).toHaveLength(3)
            return report(filePath)
          }),
        )
        yield* withTools(directory, input.lsp, (registry) =>
          Effect.gen(function* () {
            const result = yield* settleTool(
              registry,
              call("apply_patch", {
                patchText:
                  "*** Begin Patch\n*** Add File: add.ts\n+added\n*** Update File: update.ts\n@@\n-before\n+after\n*** Delete File: remove.ts\n*** End Patch",
              }),
            )
            expect(result.result.type).toBe("text")
            expect(result.output?.structured).toMatchObject({
              lsp: {
                timedOut: false,
                files: [
                  { state: "reported", filePath: path.join(directory, "add.ts") },
                  { state: "reported", filePath: path.join(directory, "update.ts") },
                  { state: "closed", filePath: path.join(directory, "remove.ts") },
                ],
              },
            })
            expect(input.queried).toEqual([path.join(directory, "add.ts"), path.join(directory, "update.ts")])
            expect(input.closed).toEqual([path.join(directory, "remove.ts")])
            expect(
              yield* Effect.promise(() =>
                fs.access(path.join(directory, "remove.ts")).then(
                  () => true,
                  () => false,
                ),
              ),
            ).toBe(false)
          }),
        )
      }),
    ),
  )

  it.live("retains the original partial-patch error and applied list when LSP follow-up times out", () =>
    withTemp((directory) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => fs.writeFile(path.join(directory, "existing.ts"), "original\n"))
        const input = fixture(() => Effect.never)
        yield* withTools(
          directory,
          input.lsp,
          (registry) =>
            Effect.gen(function* () {
              const result = yield* settleTool(
                registry,
                call("apply_patch", {
                  patchText:
                    "*** Begin Patch\n*** Add File: first.ts\n+committed\n*** Add File: existing.ts\n+replacement\n*** End Patch",
                }),
              )
              const failureValue = result.result.type === "error" ? result.result.value : undefined
              expect(result.result).toMatchObject({
                type: "error",
                value: expect.stringContaining(
                  "Patch partially applied before failing at existing.ts. Applied: first.ts",
                ),
              })
              if (result.result.type !== "error") throw new Error("Expected the original patch failure")
              expect(failureValue).toContain('"timedOut":true')
              expect(input.forgotten).toEqual([{ filePath: path.join(directory, "first.ts"), kind: "changed" }])
              expect(input.queried).toEqual([path.join(directory, "first.ts")])
              expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "first.ts"), "utf8"))).toBe(
                "committed\n",
              )
              expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "existing.ts"), "utf8"))).toBe(
                "original\n",
              )
            }),
          { timeout: 50 },
        )
      }),
    ),
  )

  it.live("performs no LSP work when mutation validation fails before a commit", () =>
    withTemp((directory) =>
      Effect.gen(function* () {
        const input = fixture()
        yield* withTools(directory, input.lsp, (registry) =>
          Effect.gen(function* () {
            const result = yield* settleTool(
              registry,
              call("apply_patch", {
                patchText:
                  "*** Begin Patch\n*** Add File: first.ts\n+created\n*** Update File: missing.ts\n@@\n-before\n+after\n*** End Patch",
              }),
            )
            expect(result.result).toEqual({ type: "error", value: "Unable to apply patch at missing.ts" })
            expect(input.forgotten).toEqual([])
            expect(input.queried).toEqual([])
            expect(input.closed).toEqual([])
          }),
        )
      }),
    ),
  )

  it.live("reports an expected LSP failure without converting a committed write into an error", () =>
    withTemp((directory) => {
      const input = fixture(() => Effect.fail(new LSPV2.Failure({ kind: "startup", message: "fixture unavailable" })))
      return withTools(directory, input.lsp, (registry) =>
        Effect.gen(function* () {
          const result = yield* settleTool(registry, call("write", { path: "file.ts", content: "saved\n" }))
          expect(result.result.type).toBe("text")
          expect(result.output?.structured).toMatchObject({ lsp: { files: [{ state: "error", failure: "startup" }] } })
          expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "file.ts"), "utf8"))).toBe("saved\n")
        }),
      )
    }),
  )

  it.live("allows another commit to the same file while the first write awaits LSP", () =>
    withTemp((directory) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let calls = 0
        const input = fixture(({ filePath }) =>
          Effect.suspend(() => {
            calls++
            if (calls > 1) return Effect.succeed(report(filePath))
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(report(filePath)),
            )
          }),
        )
        yield* withTools(directory, input.lsp, (registry) =>
          Effect.gen(function* () {
            const first = yield* settleTool(
              registry,
              call("write", { path: "file.ts", content: "first\n" }, "first"),
            ).pipe(Effect.forkChild)
            yield* Deferred.await(started)
            const second = yield* settleTool(
              registry,
              call("write", { path: "file.ts", content: "second\n" }, "second"),
            )
            expect(second.result.type).toBe("text")
            expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "file.ts"), "utf8"))).toBe("second\n")
            yield* Deferred.succeed(release, undefined)
            expect((yield* Fiber.join(first)).result.type).toBe("text")
            expect(calls).toBe(2)
          }),
        )
      }),
    ),
  )

  it.live("preserves caller interruption after a write has committed", () =>
    withTemp((directory) =>
      Effect.gen(function* () {
        let started: (() => void) | undefined
        const barrier = new Promise<void>((resolve) => {
          started = resolve
        })
        let interrupted = false
        const input = fixture(() =>
          Effect.sync(() => started?.()).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true
              }),
            ),
          ),
        )
        yield* withTools(directory, input.lsp, (registry) =>
          Effect.gen(function* () {
            const running = yield* settleTool(
              registry,
              call("write", { path: "file.ts", content: "committed\n" }),
            ).pipe(Effect.forkChild)
            yield* Effect.promise(() => barrier)
            yield* Fiber.interrupt(running)
            const exit = yield* Fiber.await(running)
            expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
            expect(interrupted).toBe(true)
            expect(yield* Effect.promise(() => fs.readFile(path.join(directory, "file.ts"), "utf8"))).toBe(
              "committed\n",
            )
            expect(input.queried).toHaveLength(1)
          }),
        )
      }),
    ),
  )

  it.live("preserves write and edit output when configured LSP does not support the file", () =>
    withTemp((directory) => {
      const input = fixture()
      return withTools(directory, input.lsp, (registry) =>
        Effect.gen(function* () {
          const written = yield* settleTool(registry, call("write", { path: "file.md", content: "before\n" }))
          expect(written.result).toEqual({ type: "text", value: "Created file successfully: file.md" })
          expect(written.output?.structured).not.toHaveProperty("lsp")
          const edited = yield* settleTool(
            registry,
            call("edit", { path: "file.md", oldString: "before", newString: "after" }),
          )
          expect(edited.result).toEqual({
            type: "text",
            value: "Edited file successfully: file.md\nReplacements: 1\n```diff\n-before\n+after\n```",
          })
          expect(edited.output?.structured).not.toHaveProperty("lsp")
          expect(input.queried).toEqual([])
          expect(input.closed).toEqual([])
        }),
      )
    }),
  )

  it.live("preserves the exact write output when LSP is disabled", () =>
    withTemp((directory) => {
      const input = fixture()
      return withTools(
        directory,
        input.lsp,
        (registry) =>
          Effect.gen(function* () {
            const result = yield* settleTool(registry, call("write", { path: "file.ts", content: "saved\n" }))
            expect(result.result).toEqual({ type: "text", value: "Created file successfully: file.ts" })
            expect(result.output?.structured).not.toHaveProperty("lsp")
            expect(input.forgotten).toEqual([])
            expect(input.queried).toEqual([])
          }),
        { enabled: false },
      )
    }),
  )
})
