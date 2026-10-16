import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { test, expect } from "bun:test"
import os from "os"
import { Cause, Effect, Exit, Layer, Ref } from "effect"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { testEffect } from "../lib/effect"
import { SessionID } from "../../src/session/schema"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const noopBootstrap = Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))
const env = AppNodeBuilder.build(
  LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]),
  [[InstanceStore.bootstrapNode, noopBootstrap]],
)
const it = testEffect(env)

const ask = (input: Parameters<Permission.Interface["ask"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.ask(input)
  })

const reply = (input: Parameters<Permission.Interface["reply"]>[0]) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.reply(input)
  })

const list = () =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission.list()
  })

// Legacy config records remain available in the normalized config representation.
// Runtime evaluation follows the shared tool policy instead.

test("fromConfig - string value becomes a wildcard record", () => {
  expect(Permission.fromConfig({ bash: "allow" })).toEqual([{ permission: "bash", pattern: "*", action: "allow" }])
})

test("fromConfig - object value converts to ordered rule records", () => {
  expect(Permission.fromConfig({ bash: { "*": "allow", rm: "deny" } })).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm", action: "deny" },
  ])
})

test("fromConfig - preserves allow, ask, and deny records in insertion order", () => {
  const result = Permission.fromConfig({
    bash: { "rm *": "deny", "git *": "ask" },
    edit: "allow",
    webfetch: "ask",
  })

  expect(result).toEqual([
    { permission: "bash", pattern: "rm *", action: "deny" },
    { permission: "bash", pattern: "git *", action: "ask" },
    { permission: "edit", pattern: "*", action: "allow" },
    { permission: "webfetch", pattern: "*", action: "ask" },
  ])
})

test("fromConfig - empty object becomes an empty ruleset", () => {
  expect(Permission.fromConfig({})).toEqual([])
})

test("fromConfig - expands home patterns without changing their actions", () => {
  expect(Permission.fromConfig({ external_directory: { "~/projects/*": "deny", "$HOME/docs/*": "ask" } })).toEqual([
    { permission: "external_directory", pattern: `${os.homedir()}/projects/*`, action: "deny" },
    { permission: "external_directory", pattern: `${os.homedir()}/docs/*`, action: "ask" },
  ])
})

test("fromConfig - expands exact tilde and $HOME paths", () => {
  expect(Permission.fromConfig({ external_directory: { "~": "allow", $HOME: "ask" } })).toEqual([
    { permission: "external_directory", pattern: os.homedir(), action: "allow" },
    { permission: "external_directory", pattern: os.homedir(), action: "ask" },
  ])
})

test("fromConfig - leaves tilde in the middle of a path unchanged", () => {
  expect(Permission.fromConfig({ external_directory: { "/some/~/path": "deny" } })).toEqual([
    { permission: "external_directory", pattern: "/some/~/path", action: "deny" },
  ])
})

test("fromConfig - preserves top-level key order", () => {
  const wildcardFirst = Permission.fromConfig({ "*": "deny", bash: "allow" })
  const specificFirst = Permission.fromConfig({ bash: "allow", "*": "deny" })

  expect(wildcardFirst.map((rule) => rule.permission)).toEqual(["*", "bash"])
  expect(specificFirst.map((rule) => rule.permission)).toEqual(["bash", "*"])
})

test("fromConfig - keeps wildcard and specific records in source order", () => {
  expect(Permission.fromConfig({ "*": "ask", bash: "allow", edit: "deny" })).toEqual([
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ])
})

test("fromConfig - preserves sub-pattern insertion order", () => {
  expect(Permission.fromConfig({ bash: { "*": "deny", "git *": "allow" } })).toEqual([
    { permission: "bash", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "git *", action: "allow" },
  ])
})

test("merge - concatenates legacy records and preserves their order and actions", () => {
  const merged = Permission.merge(
    Permission.fromConfig({ "*": "ask", bash: { "rm *": "deny" } }),
    Permission.fromConfig({ bash: "allow", edit: "deny" }),
  )

  expect(merged).toEqual([
    { permission: "*", pattern: "*", action: "ask" },
    { permission: "bash", pattern: "rm *", action: "deny" },
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "*", action: "deny" },
  ])
})

test("merge - concatenates rulesets containing the same permission", () => {
  expect(
    Permission.merge(
      [{ permission: "bash", pattern: "git *", action: "ask" }],
      [{ permission: "bash", pattern: "*", action: "deny" }],
    ),
  ).toEqual([
    { permission: "bash", pattern: "git *", action: "ask" },
    { permission: "bash", pattern: "*", action: "deny" },
  ])
})

test("merge - concatenates multiple rulesets in argument order", () => {
  expect(
    Permission.merge(
      [{ permission: "bash", pattern: "*", action: "allow" }],
      [{ permission: "edit", pattern: "src/*", action: "ask" }],
      [{ permission: "read", pattern: "*", action: "deny" }],
    ),
  ).toEqual([
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "edit", pattern: "src/*", action: "ask" },
    { permission: "read", pattern: "*", action: "deny" },
  ])
})

test("merge - empty ruleset leaves existing records unchanged", () => {
  const ruleset: PermissionV1.Ruleset = [
    { permission: "bash", pattern: "*", action: "allow" },
    { permission: "bash", pattern: "rm *", action: "deny" },
  ]

  expect(Permission.merge([...ruleset], [])).toEqual([...ruleset])
})

test("merge - preserves rule order when combining overlapping records", () => {
  expect(
    Permission.merge(
      [
        { permission: "edit", pattern: "src/*", action: "allow" },
        { permission: "edit", pattern: "src/secret/*", action: "deny" },
      ],
      [{ permission: "edit", pattern: "src/secret/ok.ts", action: "ask" }],
    ),
  ).toEqual([
    { permission: "edit", pattern: "src/*", action: "allow" },
    { permission: "edit", pattern: "src/secret/*", action: "deny" },
    { permission: "edit", pattern: "src/secret/ok.ts", action: "ask" },
  ])
})

test("evaluate - legacy allow, ask, and deny rules all yield the shared allow policy", () => {
  const rulesets: PermissionV1.Ruleset[] = [
    [],
    [{ permission: "bash", pattern: "rm *", action: "deny" }],
    [{ permission: "bash", pattern: "*", action: "ask" }],
    [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "bash", pattern: "rm *", action: "ask" },
    ],
  ]

  for (const ruleset of rulesets) {
    expect(Permission.evaluate("bash", "rm -rf /", ruleset)).toEqual({
      permission: "bash",
      pattern: "rm -rf /",
      action: "allow",
    })
  }

  expect(Permission.evaluate("new_tool", "resource").action).toBe("allow")
})

test("disabled and visibleTools leave tools available when legacy rules contain deny or ask", () => {
  const tools = { bash: {}, edit: {}, read: {} }
  const ruleset: PermissionV1.Ruleset = [
    { permission: "*", pattern: "*", action: "deny" },
    { permission: "bash", pattern: "rm *", action: "ask" },
  ]

  expect(Permission.disabled(Object.keys(tools), ruleset)).toEqual(new Set())
  expect(Permission.visibleTools(tools, ruleset)).toEqual(tools)
})

it.instance(
  "ask - deny and ask records do not queue requests or publish permission events",
  () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const eventCount = yield* Ref.make(0)
      const unsub = yield* events.listen((event) => {
        if (event.type === Permission.Event.Asked.type || event.type === Permission.Event.Replied.type)
          return Ref.update(eventCount, (count) => count + 1)
        return Effect.void
      })
      yield* Effect.addFinalizer(() => unsub)

      for (const action of ["ask", "deny"] as const) {
        const result = yield* ask({
          sessionID: SessionID.make("session_test"),
          permission: "bash",
          patterns: ["rm -rf /"],
          metadata: {},
          always: [],
          ruleset: [{ permission: "bash", pattern: "*", action }],
        })
        expect(result).toBeUndefined()
      }

      expect(yield* list()).toEqual([])
      expect(yield* Ref.get(eventCount)).toBe(0)
    }),
  { git: true },
)

it.instance(
  "reply - unknown legacy request returns NotFound",
  () =>
    Effect.gen(function* () {
      const exit = yield* reply({ requestID: PermissionV1.ID.make("per_unknown"), reply: "once" }).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(PermissionV1.NotFoundError)
      expect(yield* list()).toEqual([])
    }),
  { git: true },
)
