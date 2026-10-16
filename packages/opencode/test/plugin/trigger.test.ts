import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Fiber } from "effect"
import { ContextTrace } from "@opencode-ai/core/harness/trace"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Npm } from "@opencode-ai/core/npm"
import path from "path"
import { pathToFileURL } from "url"
import { Account } from "../../src/account/account"
import { Auth } from "../../src/auth"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Plugin } from "../../src/plugin/index"

import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Plugin.node, CrossSpawnSpawner.node]), [
    [Auth.node, AuthTest.empty],
    [Account.node, AccountTest.empty],
    [Npm.node, NpmTest.noop],
    [RuntimeFlags.node, RuntimeFlags.layer({ disableDefaultPlugins: true })],
  ]),
)
const systemHook = "experimental.chat.system.transform"

function withProject<A, E, R>(source: string | string[], self: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const test = yield* TestInstance
    const sources = typeof source === "string" ? [source] : source
    const files = sources.map((_, index) => path.join(test.directory, `plugin-${index}.ts`))
    yield* Effect.all(
      [
        ...files.map((file, index) => Effect.promise(() => Bun.write(file, sources[index]))),
        Effect.promise(() =>
          Bun.write(
            path.join(test.directory, "opencode.json"),
            JSON.stringify(
              {
                $schema: "https://opencode.ai/config.json",
                plugin: files.map((file) => pathToFileURL(file).href),
              },
              null,
              2,
            ),
          ),
        ),
      ],
      { discard: true, concurrency: 2 },
    )
    return yield* self
  })
}

const triggerSystemTransform = Effect.fn("PluginTriggerTest.triggerSystemTransform")(function* () {
  const plugin = yield* Plugin.Service
  const out = { system: [] as string[] }
  yield* plugin.trigger(
    systemHook,
    {
      model: {
        providerID: ProviderV2.ID.anthropic,
        modelID: ModelV2.ID.make("claude-sonnet-4-6"),
      },
    },
    out,
  )
  return out.system
})

describe("plugin.trigger", () => {
  it.instance("runs synchronous hooks without crashing", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: (_input, output) => {`,
        '    output.system.unshift("sync")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["sync"])
      }),
    ),
  )

  it.instance("awaits asynchronous hooks", () =>
    withProject(
      [
        "export default async () => ({",
        `  ${JSON.stringify(systemHook)}: async (_input, output) => {`,
        "    await Bun.sleep(1)",
        '    output.system.unshift("async")',
        "  },",
        "})",
        "",
      ].join("\n"),
      Effect.gen(function* () {
        expect(yield* triggerSystemTransform()).toEqual(["async"])
      }),
    ),
  )

  it.instance("attributes sequential changes and restoration to distinct registrations with duplicate ids", () =>
    withProject(
      [
        `export default { id: "duplicate", server: async () => ({ ${JSON.stringify(systemHook)}: (_input, output) => { output.system.push("added") } }) }`,
        `export default { id: "duplicate", server: async () => ({ ${JSON.stringify(systemHook)}: (_input, output) => { output.system.pop() } }) }`,
      ],
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const trace = ContextTrace.create()
        const system = ["initial"]
        const output = { system }
        const returned = yield* plugin.trigger(systemHook, {}, output, (source) =>
          trace.start({ stage: systemHook, projection: "consumed-system-array", source }, () => system),
        )
        expect(returned).toBe(output)
        expect(returned.system).toBe(system)
        expect(system).toEqual(["initial"])
        expect(yield* plugin.list()).toHaveLength(2)
        const records = trace.capture().records
        expect(records).toHaveLength(2)
        expect(records.map((item) => item.change)).toEqual(["changed", "changed"])
        expect(records.map((item) => item.source.id)).toEqual(["duplicate", "duplicate"])
        expect(records.map((item) => item.source.ordinal)).toEqual([0, 1])
        expect(records[0].source.kind).toBe("file")
        expect(records[0].source.entry).toContain("plugin-0.ts")
        expect(records[1].source.entry).toContain("plugin-1.ts")
        expect(records[0].before).toEqual(records[1].after!)
      }),
    ),
  )

  it.instance("observes the consumed array when a hook replaces an ignored wrapper property", () =>
    withProject(
      `export default async () => ({ ${JSON.stringify(systemHook)}: (_input, output) => { output.system = ["replacement"] } })`,
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const trace = ContextTrace.create()
        const system = ["consumed"]
        const output = { system }
        yield* plugin.trigger(systemHook, {}, output, (source) =>
          trace.start({ stage: systemHook, projection: "consumed-system-array", source }, () => system),
        )
        expect(output.system).toEqual(["replacement"])
        expect(system).toEqual(["consumed"])
        expect(trace.capture().records[0].change).toBe("unchanged")
        expect(trace.capture().records[0].source.id).toBe("legacy:default")
      }),
    ),
  )

  it.instance("uses unknown attribution when a caller mutates the existing hook list", () =>
    withProject(
      [
        `export default { id: "first", server: async () => ({ ${JSON.stringify(systemHook)}: (_input, output) => { output.system.push("first") } }) }`,
        `export default { id: "second", server: async () => ({ ${JSON.stringify(systemHook)}: (_input, output) => { output.system.push("second") } }) }`,
      ],
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const hooks = yield* plugin.list()
        hooks.reverse()
        const origins: ContextTrace.Origin[] = []
        const output = { system: [] as string[] }
        yield* plugin.trigger(systemHook, {}, output, (source) => {
          origins.push(source)
          return undefined
        })
        expect(yield* plugin.list()).toBe(hooks)
        expect(output.system).toEqual(["second", "first"])
        expect(origins.map((source) => [source.kind, source.id])).toEqual([
          ["runtime", "unattributed-plugin-registration"],
          ["runtime", "unattributed-plugin-registration"],
        ])
      }),
    ),
  )

  it.instance("records hook failures and preserves the original defect when an observer also throws", () =>
    withProject(
      `export default async () => ({ ${JSON.stringify(systemHook)}: () => { throw new Error("original-hook-failure") } })`,
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const trace = ContextTrace.create()
        const output = { system: ["initial"] }
        const exit = yield* plugin
          .trigger(systemHook, {}, output, (source) => {
            const finish = trace.start({ stage: systemHook, projection: "system", source }, () => output.system)
            return (outcome) => {
              finish(outcome)
              throw new Error("observer-failure")
            }
          })
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("original-hook-failure")
          expect(Cause.pretty(exit.cause)).not.toContain("observer-failure")
        }
        expect(trace.capture().records[0].status).toBe("failure")
      }),
    ),
  )

  it.instance("continues unchanged when an observer throws before hook execution", () =>
    withProject(
      `export default async () => ({ ${JSON.stringify(systemHook)}: (_input, output) => { output.system.push("hook-ran") } })`,
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const output = { system: [] as string[] }
        expect(
          yield* plugin.trigger(systemHook, {}, output, () => {
            throw new Error("bad observer")
          }),
        ).toBe(output)
        expect(output.system).toEqual(["hook-ran"])
      }),
    ),
  )

  it.instance("closes the observation on interruption without changing the hook exit", () =>
    withProject(
      `export default async () => ({ ${JSON.stringify(systemHook)}: (input) => { input.started(); return new Promise(() => {}) } })`,
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const trace = ContextTrace.create()
        const output = { system: ["initial"] }
        const started = Promise.withResolvers<void>()
        const fiber = yield* plugin
          .trigger(systemHook, { started: () => started.resolve() }, output, (source) =>
            trace.start({ stage: systemHook, projection: "system", source }, () => output.system),
          )
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => started.promise)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(trace.capture().records[0].status).toBe("interrupted")
      }),
    ),
  )

  it.instance("redacts URL credentials and query strings in declared attribution labels", () =>
    withProject(
      `export default { id: "https://user:private@example.test/plugin?token=secret#hidden", server: async () => ({ ${JSON.stringify(systemHook)}: () => {} }) }`,
      Effect.gen(function* () {
        const plugin = yield* Plugin.Service
        const sources: ContextTrace.Origin[] = []
        yield* plugin.trigger(systemHook, {}, { system: [] }, (source) => {
          sources.push(source)
          return undefined
        })
        expect(sources[0].id).toBe("https://example.test/plugin")
        expect(JSON.stringify(sources)).not.toContain("private")
        expect(JSON.stringify(sources)).not.toContain("secret")
      }),
    ),
  )
})
