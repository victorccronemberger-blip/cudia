import { describe, expect, it } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigMCP } from "@opencode-ai/core/config/mcp"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Integration } from "@opencode-ai/core/integration"
import { MCPV2 } from "@opencode-ai/core/mcp"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Wildcard } from "@opencode-ai/core/util/wildcard"
import { Deferred, Effect, Fiber, Layer, Queue, Schema, Scope } from "effect"
import { location } from "./fixture/location"

const directory = AbsolutePath.make(process.cwd())
const firstSession = SessionV2.ID.make("ses_mcp_first")
const secondSession = SessionV2.ID.make("ses_mcp_second")
const agent = AgentV2.ID.make("build")

describe("MCPV2 manager", () => {
  it("cannot recommit a startup invalidated during the final session read", async () => {
    const reached = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    let gated = false
    const server = fixture()
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const events = yield* EventV2.Service
          const starting = yield* manager.connect("fixture", context(firstSession)).pipe(Effect.forkScoped)
          yield* Deferred.await(reached)
          const profile = (yield* manager.admin.list())[0]?.authentication
          if (!profile) throw new Error("Expected remote MCP authentication profile")
          yield* events.publish(Integration.Event.ConnectionUpdated, { integrationID: profile.integrationID })
          expect((yield* manager.admin.list())[0]?.status).toBe("disconnected")
          yield* Deferred.succeed(release, undefined)
          expect((yield* Fiber.await(starting))._tag).toBe("Failure")
          expect((yield* manager.admin.list())[0]).toMatchObject({
            status: "disconnected",
            toolCount: 0,
            exposureCount: 0,
          })
          expect((yield* Effect.result(manager.expose("fixture", ["echo"], context(firstSession))))._tag).toBe(
            "Failure",
          )
          yield* manager.admin.connect("fixture")
          expect((yield* manager.admin.list())[0]?.status).toBe("connected")
          expect(server.posts.filter((method) => method === "initialize")).toHaveLength(2)
        }),
        undefined,
        undefined,
        () =>
          Effect.suspend(() => {
            if (gated || !server.posts.includes("tools/list")) return Effect.void
            gated = true
            return Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))
          }),
      )
    } finally {
      Deferred.doneUnsafe(release, Effect.void)
      await server.stop()
    }
  })

  it("shares operator connections while keeping exposures session scoped and stored deny rules inert", async () => {
    const server = fixture()
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          expect(yield* manager.admin.list()).toMatchObject([
            {
              name: "fixture",
              status: "disconnected",
              toolCount: 0,
              exposureCount: 0,
              authentication: { methodID: "oauth" },
              error: undefined,
            },
          ])
          expect(server.posts).toEqual([])
          // Operator connection admission does not require a fabricated session.
          yield* manager.admin.connect("fixture")
          expect((yield* manager.admin.list())[0]).toMatchObject({
            status: "connected",
            toolCount: 1,
            exposureCount: 0,
          })
          expect((yield* registry.materialize([], firstSession)).definitions.map((item) => item.name)).not.toContain(
            publicName,
          )
          yield* setup(
            [firstSession, secondSession],
            [
              { action: "mcp.connect", resource: "*", effect: "deny" },
              { action: "mcp.call", resource: "*", effect: "deny" },
            ],
          )
          const observed = yield* observePermissionAsks()
          expect((yield* manager.connect("fixture", context(firstSession))).exposed).toBe(0)
          expect(server.posts.filter((method) => method === "initialize")).toHaveLength(1)
          yield* manager.expose("fixture", ["echo"], context(firstSession))
          yield* manager.expose("fixture", ["echo"], context(secondSession))
          expect((yield* manager.admin.list())[0]?.exposureCount).toBe(2)
          expect((yield* manager.connect("fixture", context(firstSession))).exposed).toBe(1)
          const captured = yield* registry.materialize([], secondSession)
          yield* manager.admin.disconnect("fixture")
          expect((yield* manager.admin.list())[0]).toMatchObject({
            status: "disconnected",
            toolCount: 0,
            exposureCount: 0,
          })
          expect(
            (yield* captured.settle(toolCall(secondSession, publicName, { value: "stale" }, "call-admin-stale"))).result
              .type,
          ).toBe("error")
          expect((yield* registry.materialize([], firstSession)).definitions.map((item) => item.name)).not.toContain(
            publicName,
          )
          expect((yield* registry.materialize([], secondSession)).definitions.map((item) => item.name)).not.toContain(
            publicName,
          )
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(0)
          expect((yield* Effect.result(manager.admin.connect("unknown")))._tag).toBe("Failure")
          expect((yield* Effect.result(manager.admin.disconnect("")))._tag).toBe("Failure")
          expect((yield* Effect.result(manager.admin.connect("\ud800")))._tag).toBe("Failure")
          expect(server.posts.filter((method) => method === "initialize")).toHaveLength(1)
          yield* observed()
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("serializes operator and model connections through the same startup", async () => {
    const reached = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const server = fixture({
      beforeList: () =>
        Effect.runPromise(Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))),
    })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const operator = yield* manager.admin.connect("fixture").pipe(Effect.forkScoped)
          yield* Deferred.await(reached)
          expect((yield* manager.admin.list())[0]?.status).toBe("connecting")
          const model = yield* manager.connect("fixture", context(firstSession)).pipe(Effect.forkScoped)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(operator)
          expect((yield* Fiber.join(model)).status).toBe("connected")
          expect(server.posts.filter((method) => method === "initialize")).toHaveLength(1)
          expect(server.posts.filter((method) => method === "tools/list")).toHaveLength(1)
        }),
      )
    } finally {
      Deferred.doneUnsafe(release, Effect.void)
      await server.stop()
    }
  })

  it("does not publish a connection when its requesting session disappears during startup", async () => {
    const reached = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const server = fixture({
      beforeList: () =>
        Effect.runPromise(Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))),
    })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const connection = yield* manager.connect("fixture", context(firstSession)).pipe(Effect.forkScoped)
          yield* Deferred.await(reached)
          const { db } = yield* Database.Service
          const { eq } = yield* Effect.promise(() => import("drizzle-orm"))
          yield* db.delete(SessionTable).where(eq(SessionTable.id, firstSession)).run().pipe(Effect.orDie)
          yield* Deferred.succeed(release, undefined)
          expect((yield* Fiber.await(connection))._tag).toBe("Failure")
          expect((yield* manager.admin.list())[0]).toMatchObject({
            status: "failed",
            toolCount: 0,
            exposureCount: 0,
            error: { kind: "unavailable" },
          })
          expect((yield* Effect.result(manager.search("fixture", { query: "echo" }, context(firstSession))))._tag).toBe(
            "Failure",
          )
          // An explicit operator retry can create a fresh connection.
          yield* manager.admin.connect("fixture")
          expect((yield* manager.admin.list())[0]).toMatchObject({ status: "connected", error: undefined })
          expect(server.posts.filter((method) => method === "initialize")).toHaveLength(2)
        }),
      )
    } finally {
      Deferred.doneUnsafe(release, Effect.void)
      await server.stop()
    }
  })

  it("stays dormant until connect and settles exposed tools through the session registry", async () => {
    const server = fixture()
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession, secondSession], allow)
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service

          expect(server.posts).toEqual([])
          const disconnected = yield* Effect.result(manager.search("fixture", { query: "echo" }, context(firstSession)))
          expect(disconnected._tag).toBe("Failure")
          expect(server.posts).toEqual([])

          expect((yield* manager.connect("fixture", context(firstSession))).tools).toBe(1)
          expect(server.posts.filter((method) => method === "initialize")).toHaveLength(1)
          expect(server.posts.filter((method) => method === "tools/list")).toHaveLength(1)
          expect((yield* registry.materialize([], firstSession)).definitions.map((item) => item.name)).not.toContain(
            publicName,
          )

          const search = JSON.stringify(yield* manager.search("fixture", { query: "echo" }, context(firstSession)))
          expect(search).toContain("Echo short value")
          expect(search).not.toContain("inputSchema")
          const firstName = exposureName(yield* manager.expose("fixture", ["echo"], context(firstSession)))
          const first = yield* registry.materialize([], firstSession)
          const hiddenFromOtherSession = yield* registry.materialize([], secondSession)
          expect(first.definitions.map((item) => item.name)).toContain(firstName)
          expect(hiddenFromOtherSession.definitions.map((item) => item.name)).not.toContain(firstName)

          const invalid = yield* first.settle(toolCall(firstSession, firstName, { value: 3 }, "call-invalid"))
          expect(invalid.result.type).toBe("error")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(0)

          const secondName = exposureName(yield* manager.expose("fixture", ["echo"], context(secondSession)))
          expect(secondName).toBe(firstName)
          const second = yield* registry.materialize([], secondSession)
          const valid = yield* first.settle(toolCall(firstSession, firstName, { value: "works" }, "call-valid"))
          expect(valid.result.type).not.toBe("error")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)

          expect((yield* manager.hide("fixture", ["echo"], context(firstSession))).removed).toBe(1)
          expect((yield* registry.materialize([], firstSession)).definitions.map((item) => item.name)).not.toContain(
            firstName,
          )
          expect((yield* registry.materialize([], secondSession)).definitions.map((item) => item.name)).toContain(
            secondName,
          )

          expect((yield* manager.disconnect("fixture", context(firstSession))).removed).toBe(1)
          const stale = yield* second.settle(
            toolCall(secondSession, secondName, { value: "must not run" }, "call-stale"),
          )
          expect(stale.result.type).toBe("error")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)
          expect((yield* registry.materialize([], secondSession)).definitions.map((item) => item.name)).not.toContain(
            secondName,
          )
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("allows explicit connect when a stored deny rule matches", async () => {
    const server = fixture()
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], [{ action: "mcp.connect", resource: "*", effect: "deny" }])
          const manager = yield* MCPV2.Service
          const observed = yield* observePermissionAsks()
          const result = yield* manager.connect("fixture", context(firstSession))
          expect(result.tools).toBe(1)
          expect(server.posts.filter((method) => method === "initialize")).toHaveLength(1)
          expect(server.posts.filter((method) => method === "tools/list")).toHaveLength(1)
          yield* observed()
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("executes mcp.call despite a stored deny after connect and exposure", async () => {
    const server = fixture()
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup(
            [firstSession],
            [
              { action: "mcp.connect", resource: "*", effect: "allow" },
              { action: "mcp.expose", resource: "*", effect: "allow" },
              { action: "mcp.call", resource: "*", effect: "deny" },
            ],
          )
          const observed = yield* observePermissionAsks()
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          yield* manager.connect("fixture", context(firstSession))
          const name = exposureName(yield* manager.expose("fixture", ["echo"], context(firstSession)))
          const materialized = yield* registry.materialize([], firstSession)
          const called = yield* materialized.settle(toolCall(firstSession, name, { value: "denied" }, "call-denied"))

          expect(called.result.type).not.toBe("error")
          expect(JSON.stringify(called.result)).toContain("ok")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)
          yield* observed()
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("keeps case-variant server connections distinct while stored deny rules remain inert", async () => {
    const server = fixture()
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], [{ action: "mcp.connect", resource: "*", effect: "deny" }])
          const manager = yield* MCPV2.Service
          const observed = yield* observePermissionAsks()
          const prod = yield* manager.connect("prod", context(firstSession))
          const upper = yield* manager.connect("PROD", context(firstSession))
          expect(prod.status).toBe("connected")
          expect(upper.status).toBe("connected")
          expect((yield* manager.admin.list()).map((item) => item.name)).toContain("prod")
          expect((yield* manager.admin.list()).map((item) => item.name)).toContain("PROD")
          expect(server.posts.filter((method) => method === "initialize")).toHaveLength(2)
          expect(server.posts.filter((method) => method === "tools/list")).toHaveLength(2)
          yield* observed()
        }),
        undefined,
        ["prod", "PROD"],
      )
    } finally {
      await server.stop()
    }
  })

  it("keeps case-variant tool names distinct while stored ask and deny rules remain inert", async () => {
    const server = fixture({ caseVariantTool: true })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup(
            [firstSession],
            [
              { action: "mcp.connect", resource: "*", effect: "allow" },
              { action: "mcp.expose", resource: "*", effect: "allow" },
              { action: "mcp.call", resource: "*", effect: "ask" },
              { action: "mcp.call", resource: "*", effect: "deny" },
            ],
          )
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          const observed = yield* observePermissionAsks()

          yield* manager.connect("fixture", context(firstSession))
          const names = exposureNames(yield* manager.expose("fixture", ["echo", "ECHO"], context(firstSession)))
          expect(names).toHaveLength(2)
          expect(names[0]).not.toBe(names[1])
          const materialized = yield* registry.materialize([], firstSession)
          const lowercase = yield* materialized.settle(
            toolCall(firstSession, names[0]!, { value: "lower" }, "call-lower"),
          )
          expect(lowercase.result.type).not.toBe("error")
          expect(JSON.stringify(lowercase.result)).toContain("ok")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)

          const uppercase = yield* materialized.settle(
            toolCall(firstSession, names[1]!, { value: "upper" }, "call-upper"),
          )
          expect(uppercase.result.type).not.toBe("error")
          expect(JSON.stringify(uppercase.result)).toContain("ok")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(2)
          expect(server.calls).toEqual([
            { name: "echo", arguments: { value: "lower" } },
            { name: "ECHO", arguments: { value: "upper" } },
          ])
          yield* observed()
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("enforces the cumulative 32-tool exposure budget across batches", async () => {
    const server = fixture({ toolCount: 33 })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          yield* manager.connect("fixture", context(firstSession))
          const names = ["echo", ...Array.from({ length: 32 }, (_, index) => `tool_${index + 1}`)]
          for (let index = 0; index < 32; index += 8)
            yield* manager.expose("fixture", names.slice(index, index + 8), context(firstSession))

          const overflow = yield* Effect.result(manager.expose("fixture", [names[32]!], context(firstSession)))
          expect(overflow._tag).toBe("Failure")
          const exposed = (yield* registry.materialize([], firstSession)).definitions.filter((item) =>
            item.name.startsWith("mcp_"),
          )
          expect(exposed).toHaveLength(32)
          expect(exposed.map((item) => item.name)).not.toContain(MCPV2.toolName("fixture", names[32]!))
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("rejects an oversized exposure batch without disturbing prior tools", async () => {
    const server = fixture({ toolCount: 3, largeSchema: true })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          yield* manager.connect("fixture", context(firstSession))
          const existing = exposureName(yield* manager.expose("fixture", ["echo"], context(firstSession)))
          const oversized = yield* Effect.result(manager.expose("fixture", ["tool_1", "tool_2"], context(firstSession)))
          expect(oversized._tag).toBe("Failure")
          if (oversized._tag === "Failure") expect(oversized.failure).toMatchObject({ kind: "budget" })
          const exposed = (yield* registry.materialize([], firstSession)).definitions.map((item) => item.name)
          expect(exposed).toContain(existing)
          expect(exposed).not.toContain(MCPV2.toolName("fixture", "tool_1"))
          expect(exposed).not.toContain(MCPV2.toolName("fixture", "tool_2"))
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("fails connection setup for duplicate catalog names", async () => {
    const server = fixture({ duplicateNames: true })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const result = yield* Effect.result(manager.connect("fixture", context(firstSession)))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(result.failure).toMatchObject({ kind: "catalog" })
          expect(server.posts.filter((method) => method === "tools/list")).toHaveLength(1)
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("rejects malformed configured server and requested tool identifiers before RPC", async () => {
    const malformed = "bad\uD800"
    const server = fixture()
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const result = yield* Effect.result(manager.servers({ query: "bad" }, context(firstSession)))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(result.failure).toMatchObject({ kind: "catalog" })
          expect(server.posts).toEqual([])
        }),
        undefined,
        [malformed],
      )
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          yield* manager.connect("fixture", context(firstSession))
          const before = server.posts.length
          const result = yield* Effect.result(manager.expose("fixture", [malformed], context(firstSession)))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(result.failure).toMatchObject({ kind: "catalog" })
          expect(server.posts.length).toBe(before)
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("includes delayed catalog discovery in the configured startup timeout", async () => {
    const server = fixture({ listDelayMs: 300 })
    const shortStartup = new ConfigMCP.Timeout({ startup: 80, request: 1_000 })
    const longerStartup = new ConfigMCP.Timeout({ startup: 1_000, request: 1_000 })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const result = yield* Effect.result(manager.connect("fixture", context(firstSession)))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(result.failure).toMatchObject({ kind: "timeout" })
        }),
        shortStartup,
      )
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          expect((yield* manager.connect("fixture", context(firstSession))).tools).toBe(1)
        }),
        longerStartup,
      )
    } finally {
      await server.stop()
    }
  })

  it("bounds a slow paginated refresh and keeps disconnected snapshots inert", async () => {
    const server = fixture({ listChangedOnCall: true, pagedRefresh: true, pageDelayMs: 60 })
    const timeout = new ConfigMCP.Timeout({ startup: 1_000, request: 80 })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          yield* manager.connect("fixture", context(firstSession))
          const name = exposureName(yield* manager.expose("fixture", ["echo"], context(firstSession)))
          const captured = yield* registry.materialize([], firstSession)
          const changed = yield* captured.settle(toolCall(firstSession, name, { value: "once" }, "call-slow-change"))
          expect(changed.result.type).not.toBe("error")
          expect(JSON.stringify(changed.result)).toContain("ok")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)

          const started = Date.now()
          const refresh = yield* Effect.result(manager.search("fixture", { query: "echo" }, context(firstSession)))
          const elapsed = Date.now() - started
          expect(refresh._tag).toBe("Failure")
          if (refresh._tag === "Failure") expect(refresh.failure).toMatchObject({ kind: "timeout" })
          expect(elapsed).toBeLessThan(250)
          const listingsAtTimeout = server.posts.filter((method) => method === "tools/list").length
          expect(listingsAtTimeout).toBe(3)
          yield* Effect.sleep(100)
          expect(server.posts.filter((method) => method === "tools/list")).toHaveLength(listingsAtTimeout)

          const stillDirty = yield* captured.settle(
            toolCall(firstSession, name, { value: "must not replay" }, "call-dirty-snapshot"),
          )
          expect(stillDirty.result.type).toBe("error")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)
          yield* manager.disconnect("fixture", context(firstSession))
          const afterDisconnect = yield* captured.settle(
            toolCall(firstSession, name, { value: "must remain inert" }, "call-disconnected-snapshot"),
          )
          expect(afterDisconnect.result.type).toBe("error")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)
        }),
        timeout,
      )
    } finally {
      await server.stop()
    }
  })

  it("invalidates a changed catalog without auto-fetch or replay, then refreshes on search", async () => {
    const server = fixture({ listChangedOnCall: true })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          yield* manager.connect("fixture", context(firstSession))
          const name = exposureName(yield* manager.expose("fixture", ["echo"], context(firstSession)))
          const materialized = yield* registry.materialize([], firstSession)
          const called = yield* materialized.settle(toolCall(firstSession, name, { value: "once" }, "call-changed"))

          expect(called.result.type).not.toBe("error")
          expect(JSON.stringify(called.result)).toContain("ok")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)
          expect(server.posts.filter((method) => method === "tools/list")).toHaveLength(1)

          const stale = yield* materialized.settle(
            toolCall(firstSession, name, { value: "must not replay" }, "call-stale"),
          )
          expect(stale.result.type).toBe("error")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)

          const search = JSON.stringify(yield* manager.search("fixture", { query: "echo" }, context(firstSession)))
          expect(search).toContain("Echo updated value")
          expect(server.posts.filter((method) => method === "tools/list")).toHaveLength(2)
          const refreshedName = exposureName(yield* manager.expose("fixture", ["echo"], context(firstSession)))
          const refreshed = yield* registry.materialize([], firstSession)
          expect(refreshed.definitions.map((item) => item.name)).toContain(refreshedName)
          const refreshedCall = yield* refreshed.settle(
            toolCall(firstSession, refreshedName, { value: "after refresh" }, "call-after-refresh"),
          )
          expect(refreshedCall.result.type).not.toBe("error")
          expect(JSON.stringify(refreshedCall.result)).toContain("ok")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(2)
          expect(server.posts.filter((method) => method === "tools/list")).toHaveLength(2)
          const stillStale = yield* refreshed.settle(
            toolCall(firstSession, refreshedName, { value: "must not replay" }, "call-after-refresh-stale"),
          )
          expect(stillStale.result.type).toBe("error")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(2)
          expect(server.posts.filter((method) => method === "tools/list")).toHaveLength(2)
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("keeps genuine JSON-RPC call failures when the response also changes the catalog", async () => {
    const server = fixture({ listChangedOnCall: true, callErrorOnCall: true })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          yield* manager.connect("fixture", context(firstSession))
          const name = exposureName(yield* manager.expose("fixture", ["echo"], context(firstSession)))
          const captured = yield* registry.materialize([], firstSession)

          const failed = yield* captured.settle(toolCall(firstSession, name, { value: "fails" }, "call-jsonrpc-error"))
          expect(failed.result.type).toBe("error")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)

          const stale = yield* captured.settle(
            toolCall(firstSession, name, { value: "must not replay" }, "call-jsonrpc-error-stale"),
          )
          expect(stale.result.type).toBe("error")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)

          const refreshed = JSON.stringify(yield* manager.search("fixture", { query: "echo" }, context(firstSession)))
          expect(refreshed).toContain("Echo updated value")
          const refreshedName = exposureName(yield* manager.expose("fixture", ["echo"], context(firstSession)))
          const current = yield* registry.materialize([], firstSession)
          const failedAfterRefresh = yield* current.settle(
            toolCall(firstSession, refreshedName, { value: "still fails" }, "call-jsonrpc-error-after-refresh"),
          )
          expect(failedAfterRefresh.result.type).toBe("error")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(2)
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("rolls back an exposure batch if any remote schema is unsupported", async () => {
    const server = fixture({ unsupportedSchema: true })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          yield* manager.connect("fixture", context(firstSession))
          const exposure = yield* Effect.result(
            manager.expose("fixture", ["echo", "unsupported"], context(firstSession)),
          )
          expect(exposure._tag).toBe("Failure")
          expect((yield* registry.materialize([], firstSession)).definitions.map((item) => item.name)).not.toContain(
            publicName,
          )
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("closes session registrations when the location service scope closes", async () => {
    const server = fixture()
    try {
      const result = await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          yield* manager.connect("fixture", context(firstSession))
          const name = exposureName(yield* manager.expose("fixture", ["echo"], context(firstSession)))
          expect((yield* registry.materialize([], firstSession)).definitions.map((item) => item.name)).toContain(name)
          return { registry, name }
        }),
      )
      const afterClose = await Effect.runPromise(result.registry.materialize([], firstSession))
      expect(afterClose.definitions.map((item) => item.name)).not.toContain(result.name)
    } finally {
      await server.stop()
    }
  })

  it("removes deleted-session exposures and rejects captured calls", async () => {
    const server = fixture()
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([firstSession], allow)
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          yield* manager.connect("fixture", context(firstSession))
          const name = exposureName(yield* manager.expose("fixture", ["echo"], context(firstSession)))
          const captured = yield* registry.materialize([], firstSession)
          const events = yield* EventV2.Service
          const now = Date.now()
          yield* events.publish(SessionV1.Event.Deleted, {
            sessionID: firstSession,
            info: SessionV1.SessionInfo.make({
              id: firstSession,
              slug: "deleted",
              version: "test",
              projectID: Project.ID.global,
              directory,
              path: "",
              title: "deleted",
              agent: "build",
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: now, updated: now },
            }),
          })

          expect((yield* registry.materialize([], firstSession)).definitions.map((item) => item.name)).not.toContain(
            name,
          )
          const stale = yield* captured.settle(toolCall(firstSession, name, { value: "deleted" }, "call-deleted"))
          expect(stale.result.type).toBe("error")
          expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(0)
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("escapes literal wildcard characters in permission resources", () => {
    expect(MCPV2.resource("fixture", "*")).toBe("~66697874757265/~2a")
    expect(MCPV2.serverResource("prod*")).toBe("~70726f642a")
    expect(MCPV2.serverResource("Å")).toBe("~c385")
    expect(MCPV2.toolName("fixture", "echo")).toBe(publicName)
    expect(Wildcard.match("folder\\file.ts", "folder/*.ts")).toBe(true)
    expect(Wildcard.match("product-1", "product-?")).toBe(true)
    expect(Wildcard.match("product", "product-?")).toBe(false)
    expect(Wildcard.match("PROD", "prod")).toBe(process.platform === "win32")
    expect(Wildcard.match("É", "é")).toBe(process.platform === "win32")
  })
})

const allow: PermissionV2.Ruleset = [{ action: "mcp.*", resource: "*", effect: "allow" }]
const publicName = MCPV2.toolName("fixture", "echo")

function runtime(
  url: string,
  timeout?: ConfigMCP.Timeout,
  serverNames: readonly string[] = ["fixture"],
  sessionRead: () => Effect.Effect<void> = () => Effect.void,
) {
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({
              mcp: new ConfigMCP.Info({
                servers: Object.fromEntries(
                  serverNames.map((name) => [name, new ConfigMCP.Remote({ type: "remote", url })]),
                ),
                timeout,
              }),
            }),
          }),
        ]),
    }),
  )
  const current = Layer.succeed(Location.Service, Location.Service.of(location({ directory })))
  const database = Database.layerFromPath(":memory:")
  // Gate the actual store read to exercise invalidation at its asynchronous boundary.
  const store = Layer.effect(
    SessionStore.Service,
    Effect.gen(function* () {
      const original = yield* SessionStore.Service
      return SessionStore.Service.of({ ...original, get: (id) => original.get(id).pipe(Effect.tap(sessionRead)) })
    }),
  ).pipe(Layer.provide(LayerNode.compile(SessionStore.node, [[Database.node, database]])))
  return AppNodeBuilder.build(
    LayerNode.group([MCPV2.node, ToolRegistry.node, AgentV2.node, Database.node, EventV2.node, PermissionV2.node]),
    [
      [Config.node, config],
      [Location.node, current],
      [Database.node, database],
      [SessionStore.node, store],
    ],
  )
}

function run<A, E>(
  url: string,
  program: Effect.Effect<
    A,
    E,
    | Database.Service
    | AgentV2.Service
    | MCPV2.Service
    | ToolRegistry.Service
    | EventV2.Service
    | PermissionV2.Service
    | Scope.Scope
  >,
  timeout?: ConfigMCP.Timeout,
  serverNames?: readonly string[],
  sessionRead?: () => Effect.Effect<void>,
) {
  return Effect.runPromise(Effect.scoped(Effect.provide(program, runtime(url, timeout, serverNames, sessionRead))))
}

function observePermissionAsks() {
  return Effect.gen(function* () {
    const events = yield* EventV2.Service
    const permissions = yield* PermissionV2.Service
    const asked = yield* Queue.unbounded<PermissionV2.Request>()
    const unsubscribe = yield* events.listen((event) =>
      event.type === PermissionV2.Event.Asked.type
        ? Queue.offer(asked, event.data as PermissionV2.Request).pipe(Effect.asVoid)
        : Effect.void,
    )
    yield* Effect.addFinalizer(() => unsubscribe)
    return () =>
      Effect.gen(function* () {
        expect((yield* Queue.poll(asked))._tag).toBe("None")
        expect(yield* permissions.list()).toEqual([])
      })
  })
}

function setup(sessionIDs: readonly SessionV2.ID[], rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      sessionIDs,
      (id) =>
        db
          .insert(SessionTable)
          .values({
            id,
            project_id: Project.ID.global,
            slug: id,
            directory,
            title: id,
            version: "test",
            agent: "build",
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie),
      { discard: true },
    )
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(agent, (value) => {
        value.permissions = [...rules]
      }),
    )
  })
}

function context(sessionID: SessionV2.ID) {
  return {
    sessionID,
    agent,
    assistantMessageID: SessionMessage.ID.make("msg_mcp_test"),
    toolCallID: "call_mcp_test",
  }
}

function toolCall(sessionID: SessionV2.ID, name: string, input: unknown, id: string) {
  return {
    sessionID,
    agent,
    assistantMessageID: SessionMessage.ID.make("msg_mcp_settlement"),
    call: { type: "tool-call" as const, id, name, input },
  }
}

function exposureName(value: unknown) {
  return exposureNames(value)[0]!
}

function exposureNames(value: unknown) {
  return Schema.decodeUnknownSync(
    Schema.Struct({ tools: Schema.Array(Schema.Struct({ tool: Schema.String, name: Schema.String })) }),
  )(value).tools.map((item) => item.name)
}

type Request = {
  readonly id?: number | string
  readonly method: string
  readonly params?: {
    readonly name?: string
    readonly arguments?: Record<string, unknown>
    readonly cursor?: string
  }
}

function fixture(
  options: {
    readonly listChangedOnCall?: boolean
    readonly unsupportedSchema?: boolean
    readonly toolCount?: number
    readonly largeSchema?: boolean
    readonly duplicateNames?: boolean
    readonly caseVariantTool?: boolean
    readonly listDelayMs?: number
    readonly pagedRefresh?: boolean
    readonly pageDelayMs?: number
    readonly callErrorOnCall?: boolean
    readonly beforeList?: () => Promise<unknown>
  } = {},
) {
  const posts: string[] = []
  const calls: { readonly name: string | undefined; readonly arguments: Record<string, unknown> | undefined }[] = []
  let revision = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.method === "GET") return new Response(null, { status: 405 })
      const message = (await request.json()) as Request
      posts.push(message.method)
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (message.method === "initialize")
        return response(
          message,
          {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fixture", version: "1.0.0" },
          },
          true,
        )
      if (message.method === "tools/list") {
        if (options.beforeList) await options.beforeList()
        if (options.listDelayMs) await new Promise((resolve) => setTimeout(resolve, options.listDelayMs))
        if (options.pagedRefresh && revision > 0) {
          if (options.pageDelayMs) await new Promise((resolve) => setTimeout(resolve, options.pageDelayMs))
          const page = message.params?.cursor?.startsWith("page-")
            ? Number(message.params.cursor.slice("page-".length))
            : 1
          const nextCursor = page < 4 ? `page-${page + 1}` : undefined
          return response(
            message,
            {
              tools: [{ ...echoTool, name: page === 1 ? "echo" : `refreshed_${page}` }],
              ...(nextCursor ? { nextCursor } : {}),
            },
            true,
          )
        }
        const tools = [
          { ...echoTool, description: revision === 0 ? "Echo short value" : "Echo updated value" },
          ...Array.from({ length: Math.max(0, (options.toolCount ?? 1) - 1) }, (_, index) => ({
            name: `tool_${index + 1}`,
            description: `Fixture tool ${index + 1}`,
            inputSchema: options.largeSchema
              ? {
                  type: "object",
                  properties: Object.fromEntries(
                    Array.from({ length: 700 }, (_, property) => [`field_${property}`, { type: "string" }]),
                  ),
                }
              : echoTool.inputSchema,
          })),
          ...(options.unsupportedSchema ? [unsupportedTool] : []),
          ...(options.caseVariantTool ? [{ ...echoTool, name: "ECHO" }] : []),
        ]
        return response(
          message,
          { tools: options.duplicateNames ? [echoTool, { ...echoTool, description: "Duplicate" }] : tools },
          true,
        )
      }
      if (message.method === "tools/call") {
        calls.push({ name: message.params?.name, arguments: message.params?.arguments })
        if (options.callErrorOnCall) {
          const error = {
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32000, message: "Fixture tool call failed" },
          }
          if (options.listChangedOnCall) {
            revision++
            return Response.json([{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }, error], {
              headers: { "mcp-session-id": "fixture-session" },
            })
          }
          return Response.json(error, { headers: { "mcp-session-id": "fixture-session" } })
        }
        const result = {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: "ok" }],
            structuredContent: { value: message.params?.arguments?.value },
          },
        }
        if (options.listChangedOnCall) {
          revision++
          return Response.json([{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }, result], {
            headers: { "mcp-session-id": "fixture-session" },
          })
        }
        return Response.json(result, { headers: { "mcp-session-id": "fixture-session" } })
      }
      return new Response(null, { status: 202 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    posts,
    calls,
    stop: () => server.stop(true),
  }
}

const echoTool = {
  name: "echo",
  description: "Echo a short value",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
}

const unsupportedTool = {
  name: "unsupported",
  description: "Unsupported schema",
  inputSchema: { $schema: "https://example.invalid/unsupported", type: "object" },
}

function response(message: Request, result: unknown, session = false) {
  return Response.json(
    { jsonrpc: "2.0", id: message.id, result },
    { headers: session ? { "mcp-session-id": "fixture-session" } : undefined },
  )
}
