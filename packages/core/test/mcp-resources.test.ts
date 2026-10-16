import { describe, expect, it } from "bun:test"
import path from "path"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigMCP } from "@opencode-ai/core/config/mcp"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { MCPV2 } from "@opencode-ai/core/mcp"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { MCPTool } from "@opencode-ai/core/tool/mcp"
import { ReadTool } from "@opencode-ai/core/tool/read"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Deferred, Effect, Fiber, Layer, Schema, Scope } from "effect"
import { location } from "./fixture/location"

const directory = AbsolutePath.make(process.cwd())
const sessionID = SessionV2.ID.make("ses_mcp_resources")
const agent = AgentV2.ID.make("build")
const uri = "custom:folder/a%2Fb?x=*"
const rules: PermissionV2.Ruleset = [
  { action: "mcp.*", resource: "*", effect: "allow" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "allow" },
]

describe("MCPV2 resources", () => {
  it("keeps a resource-only server dormant until connect and never exposes its metadata as tools", async () => {
    const server = fixture({ toolSupport: false })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup(rules)
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          expect(server.posts).toEqual([])
          yield* manager.admin.connect("fixture")
          expect(server.posts).toContain("initialize")
          expect(server.posts).not.toContain("resources/list")
          expect(server.posts).not.toContain("resources/templates/list")
          expect(server.posts).not.toContain("resources/read")
          expect((yield* registry.materialize([], sessionID)).definitions.map((item) => item.name)).not.toContain(
            MCPV2.toolName("fixture", "echo"),
          )

          const result = yield* manager.resources("fixture", { query: "report" }, context())
          expect(result).toMatchObject({ supported: true, total: 3 })
          expect(server.posts.filter((method) => method === "resources/list")).toHaveLength(1)
          expect(server.posts.filter((method) => method === "resources/templates/list")).toHaveLength(0)
          expect(server.posts.filter((method) => method === "resources/read")).toHaveLength(0)
          expect((yield* registry.materialize([], sessionID)).definitions.map((item) => item.name)).not.toContain(
            MCPV2.toolName("fixture", "echo"),
          )
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("preserves URI validation and reads through legacy deny records", async () => {
    const server = fixture()
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup([
            { action: "mcp.connect", resource: "*", effect: "allow" },
            { action: "mcp.resources", resource: "*", effect: "deny" },
          ])
          const manager = yield* MCPV2.Service
          yield* manager.admin.connect("fixture")
          const listed = yield* Effect.result(manager.resources("fixture", { query: "report" }, context()))
          expect(listed._tag).toBe("Success")
          expect(server.posts.filter((method) => method === "resources/list")).toHaveLength(1)
          yield* setup(rules)
          yield* manager.resources("fixture", { query: "report" }, context())
          yield* setup([
            ...rules,
            { action: "mcp.resource.read", resource: MCPV2.resource("fixture", uri), effect: "deny" },
          ])
          const readWithLegacyDeny = yield* Effect.result(manager.read("fixture", uri, context()))
          expect(readWithLegacyDeny._tag).toBe("Success")
          expect(server.posts.filter((method) => method === "resources/read")).toHaveLength(1)
          yield* setup(rules)
          const result = yield* manager.read("fixture", uri, context())
          expect(result.contents).toEqual([
            { uri, mimeType: "text/plain", text: "hello" },
            { uri, mimeType: "application/octet-stream", blob: "aGVsbG8=" },
            { uri, mimeType: "text/plain", text: "world" },
          ])
          expect(server.readURIs).toEqual([uri, uri])
          expect(MCPV2.resource("fixture", uri)).toBe("~66697874757265/~637573746f6d3a666f6c6465722f61253246623f783d2a")
          const invalidURIs = ["", "\ud800", "é".repeat(4_097)]
          for (const invalid of invalidURIs) {
            expect((yield* Effect.result(manager.read("fixture", invalid, context())))._tag).toBe("Failure")
          }
          expect(server.readURIs).toEqual([uri, uri])
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("attaches receipts only to text resources with the requested and returned URI", async () => {
    const contents: MCPV2.ResourceResult["contents"] = [
      { uri: "https://fixture.test/returned/first", mimeType: "text/plain", text: "hello" },
      { uri: "https://fixture.test/returned/binary", mimeType: "application/octet-stream", blob: "aGVsbG8=" },
      { uri: "https://fixture.test/returned/second", mimeType: "text/plain", text: "world" },
    ]
    const server = fixture({ readContents: contents })
    try {
      const settled = await readThroughTool(server.url)
      expect(settled.result).toEqual({
        type: "content",
        value: [
          { type: "text", text: '{"uri":"https://fixture.test/returned/first","mimeType":"text/plain"}\nhello' },
          { type: "text", text: JSON.stringify(contents[1]) },
          { type: "text", text: '{"uri":"https://fixture.test/returned/second","mimeType":"text/plain"}\nworld' },
        ],
      })
      expect(settled.contextSources).toMatchObject({
        version: 1,
        projection: "original",
        omitted: 0,
        entries: [
          { contentIndex: 0, receipt: { kind: "mcp-resource" } },
          { contentIndex: 2, receipt: { kind: "mcp-resource" } },
        ],
      })
      const entries = settled.contextSources?.entries ?? []
      expect(entries.map((entry) => entry.contentIndex)).toEqual([0, 2])
      expect(entries.map((entry) => entry.receipt.origin)).toEqual([
        JSON.stringify({ server: "fixture", requestedURI: uri, uri: contents[0]?.uri }),
        JSON.stringify({ server: "fixture", requestedURI: uri, uri: contents[2]?.uri }),
      ])
      for (const entry of entries) {
        const rendered = (settled.output?.content[entry.contentIndex] as { type: "text"; text: string }).text
        const observation = ToolSource.inspect(rendered, { contextSource: entry.receipt })
        expect(observation).toMatchObject({ state: "matched", kind: "mcp-resource", origin: entry.receipt.origin })
        if (observation.state !== "matched" || observation.body.type !== "utf16-span")
          throw new Error("Expected a matched resource text span")
        expect(rendered.slice(observation.body.start, observation.body.end)).toBe(
          entry.contentIndex === 0 ? "hello" : "world",
        )
      }
    } finally {
      await server.stop()
    }
  })

  it("keeps identical resource text distinguishable by returned URI", async () => {
    const server = fixture({
      readContents: ["first", "second"].map((name) => ({
        uri: `https://fixture.test/${name}`,
        mimeType: "text/plain",
        text: "repeated text",
      })),
    })
    try {
      const settled = await readThroughTool(server.url)
      const entries = settled.contextSources?.entries ?? []
      expect(entries).toHaveLength(2)
      expect(entries[0]?.receipt.body.sha256).toBe(entries[1]?.receipt.body.sha256)
      expect(entries[0]?.receipt.origin).not.toBe(entries[1]?.receipt.origin)
      expect(entries.map((entry) => JSON.parse(entry.receipt.origin))).toEqual([
        { server: "fixture", requestedURI: uri, uri: "https://fixture.test/first" },
        { server: "fixture", requestedURI: uri, uri: "https://fixture.test/second" },
      ])
    } finally {
      await server.stop()
    }
  })

  it("does not attach resource receipts to server or catalog operations", async () => {
    const server = fixture()
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup(rules)
          const registry = yield* ToolRegistry.Service
          const materialized = yield* registry.materialize([], sessionID)
          const connect = yield* materialized.settle(
            toolCall("mcp", { operation: "connect", server: "fixture" }, "call-connect-no-source"),
          )
          expect(connect.contextSources).toBeUndefined()

          const operations = [
            { operation: "servers", query: "" },
            { operation: "search", server: "fixture", query: "echo" },
            { operation: "resources", server: "fixture", query: "report" },
            { operation: "templates", server: "fixture", query: "report" },
          ]
          for (const [index, input] of operations.entries()) {
            const settled = yield* materialized.settle(toolCall("mcp", input, `call-catalog-${index}`))
            expect(settled.result.type).not.toBe("error")
            expect(settled.contextSources).toBeUndefined()
          }
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("bounds resource receipts and counts omitted text entries without counting binary content", async () => {
    const many = fixture({
      readContents: Array.from({ length: 10 }, (_, index) => ({
        uri: `https://fixture.test/returned/${index}`,
        mimeType: "text/plain",
        text: `resource-${index}`,
      })),
    })
    try {
      const settled = await readThroughTool(many.url)
      expect(settled.contextSources).toMatchObject({
        version: 1,
        projection: "original",
        omitted: 2,
      })
      expect(settled.contextSources?.entries.map((entry) => entry.contentIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      expect(settled.output?.content).toHaveLength(10)
    } finally {
      await many.stop()
    }

    const longOrigins = fixture({
      readContents: [0, 1].map((index) => ({
        uri: `https://fixture.test/${index}/${"x".repeat(1_100)}`,
        mimeType: "text/plain",
        text: `long-origin-${index}`,
      })),
    })
    try {
      const settled = await readThroughTool(longOrigins.url)
      expect(settled.contextSources).toMatchObject({ version: 1, projection: "original", entries: [], omitted: 2 })
      expect(settled.result.type).toBe("content")
    } finally {
      await longOrigins.stop()
    }

    const binary = fixture({
      readContents: [{ uri: "https://fixture.test/blob", mimeType: "application/octet-stream", blob: "aGVsbG8=" }],
    })
    try {
      const settled = await readThroughTool(binary.url)
      expect(settled.contextSources).toMatchObject({ version: 1, projection: "original", entries: [], omitted: 0 })
      expect(settled.result).toEqual({
        type: "text",
        value: JSON.stringify({
          uri: "https://fixture.test/blob",
          mimeType: "application/octet-stream",
          blob: "aGVsbG8=",
        }),
      })
    } finally {
      await binary.stop()
    }
  })

  it("paginates a filtered snapshot and preserves exposed tools after a resource notification", async () => {
    const server = fixture({ pageSize: 2 })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup(rules)
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          yield* manager.admin.connect("fixture")
          yield* manager.expose("fixture", ["echo"], context())
          const exposedName = MCPV2.toolName("fixture", "echo")
          yield* manager.templates("fixture", { query: "report" }, context())
          const first = yield* manager.resources("fixture", { query: "report", limit: 1 }, context())
          expect(first).toMatchObject({ supported: true, total: 3, nextOffset: 1 })
          const snapshot = field(first, "snapshot")
          expect(
            (yield* Effect.result(manager.resources("fixture", { query: "report", limit: 1, offset: 1 }, context())))
              ._tag,
          ).toBe("Failure")
          expect(
            (yield* Effect.result(
              manager.resources("fixture", { query: "other", limit: 1, offset: 1, snapshot }, context()),
            ))._tag,
          ).toBe("Failure")
          expect(
            (yield* Effect.result(
              manager.templates("fixture", { query: "report", limit: 1, offset: 1, snapshot }, context()),
            ))._tag,
          ).toBe("Failure")
          const second = yield* manager.resources(
            "fixture",
            { query: "report", limit: 1, offset: 1, snapshot },
            context(),
          )
          expect(second).toMatchObject({ total: 3, nextOffset: 2 })
          expect(server.posts.filter((method) => method === "resources/list")).toHaveLength(2)
          expect(server.posts.filter((method) => method === "resources/read")).toHaveLength(0)

          server.changeResources()
          const stale = yield* Effect.result(manager.resources("fixture", { query: "report", limit: 1 }, context()))
          expect(stale._tag).toBe("Failure")
          if (stale._tag === "Failure") expect(stale.failure).toMatchObject({ kind: "stale" })
          expect(yield* manager.templates("fixture", { query: "report" }, context())).toMatchObject({
            total: 1,
            matches: [{ description: "A report by year updated" }],
          })
          expect(server.posts.filter((method) => method === "resources/templates/list")).toHaveLength(2)
          const refreshed = yield* manager.resources("fixture", { query: "report", limit: 1 }, context())
          expect(refreshed).toMatchObject({ total: 3, nextOffset: 1 })
          expect(server.posts.filter((method) => method === "resources/list")).toHaveLength(6)
          expect((yield* registry.materialize([], sessionID)).definitions.map((item) => item.name)).toContain(
            exposedName,
          )
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("fetches templates only on request and distinguishes unsupported capability from an empty catalog", async () => {
    const server = fixture()
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup(rules)
          const manager = yield* MCPV2.Service
          yield* manager.admin.connect("fixture")
          const templates = yield* manager.templates("fixture", { query: "report" }, context())
          expect(templates).toMatchObject({ supported: true, total: 1 })
          expect(server.posts.filter((method) => method === "resources/templates/list")).toHaveLength(1)
          expect(server.posts.filter((method) => method === "resources/list")).toHaveLength(0)
        }),
      )
    } finally {
      await server.stop()
    }

    const unsupported = fixture({ resourceSupport: false })
    try {
      await run(
        unsupported.url,
        Effect.gen(function* () {
          yield* setup(rules)
          const manager = yield* MCPV2.Service
          yield* manager.admin.connect("fixture")
          expect(yield* manager.resources("fixture", { query: "none" }, context())).toEqual({
            supported: false,
            matches: [],
            total: 0,
          })
          expect(yield* manager.templates("fixture", { query: "none" }, context())).toEqual({
            supported: false,
            matches: [],
            total: 0,
          })
          expect(unsupported.posts.filter((method) => method.startsWith("resources/"))).toEqual([])
        }),
      )
    } finally {
      await unsupported.stop()
    }
  })

  it("rejects duplicate exact URIs as a typed catalog failure while retaining case variants", async () => {
    const duplicate = fixture({ duplicateResources: true })
    try {
      await run(
        duplicate.url,
        Effect.gen(function* () {
          yield* setup(rules)
          const manager = yield* MCPV2.Service
          yield* manager.admin.connect("fixture")
          const result = yield* Effect.result(manager.resources("fixture", { query: "report" }, context()))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(result.failure).toMatchObject({ kind: "catalog" })
        }),
      )
    } finally {
      await duplicate.stop()
    }

    const variants = fixture({ caseVariantResources: true })
    try {
      await run(
        variants.url,
        Effect.gen(function* () {
          yield* setup(rules)
          const manager = yield* MCPV2.Service
          yield* manager.admin.connect("fixture")
          expect(yield* manager.resources("fixture", { query: "report" }, context())).toMatchObject({ total: 4 })
        }),
      )
    } finally {
      await variants.stop()
    }

    const duplicateTemplate = fixture({ duplicateTemplates: true })
    try {
      await run(
        duplicateTemplate.url,
        Effect.gen(function* () {
          yield* setup(rules)
          const manager = yield* MCPV2.Service
          yield* manager.admin.connect("fixture")
          const result = yield* Effect.result(manager.templates("fixture", { query: "report" }, context()))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(result.failure).toMatchObject({ kind: "catalog" })
        }),
      )
    } finally {
      await duplicateTemplate.stop()
    }
  })

  it("returns a typed request failure when an advertised resource catalog fails", async () => {
    const server = fixture({ resourceListFailure: true })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup(rules)
          const manager = yield* MCPV2.Service
          yield* manager.admin.connect("fixture")
          const result = yield* Effect.result(manager.resources("fixture", { query: "report" }, context()))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(result.failure).toMatchObject({ kind: "request" })
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("rejects an in-flight catalog fetch made stale by a notification and discards reads after disconnect", async () => {
    const reached = Deferred.makeUnsafe<void>()
    const release = Deferred.makeUnsafe<void>()
    const server = fixture({
      beforeResourceList: () =>
        Effect.runPromise(Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release)))),
    })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup(rules)
          const manager = yield* MCPV2.Service
          yield* manager.admin.connect("fixture")
          const listing = yield* Effect.result(manager.resources("fixture", { query: "report" }, context())).pipe(
            Effect.forkScoped,
          )
          yield* Deferred.await(reached)
          server.changeResources()
          yield* Deferred.succeed(release, undefined)
          const result = yield* Fiber.join(listing)
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") expect(result.failure).toMatchObject({ kind: "stale" })

          const readReached = Deferred.makeUnsafe<void>()
          const readRelease = Deferred.makeUnsafe<void>()
          server.gateRead(() =>
            Effect.runPromise(
              Deferred.succeed(readReached, undefined).pipe(Effect.andThen(Deferred.await(readRelease))),
            ),
          )
          const reading = yield* Effect.result(manager.read("fixture", uri, context())).pipe(Effect.forkScoped)
          yield* Deferred.await(readReached)
          yield* manager.admin.disconnect("fixture")
          yield* Deferred.succeed(readRelease, undefined)
          expect((yield* Fiber.join(reading))._tag).toBe("Failure")

          yield* manager.admin.connect("fixture")
          const lateReached = Deferred.makeUnsafe<void>()
          const lateRelease = Deferred.makeUnsafe<void>()
          server.gateRead(() =>
            Effect.runPromise(
              Deferred.succeed(lateReached, undefined).pipe(Effect.andThen(Deferred.await(lateRelease))),
            ),
          )
          const late = yield* Effect.result(manager.read("fixture", uri, context())).pipe(Effect.forkScoped)
          yield* Deferred.await(lateReached)
          const { db } = yield* Database.Service
          const { eq } = yield* Effect.promise(() => import("drizzle-orm"))
          yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
          yield* Deferred.succeed(lateRelease, undefined)
          expect((yield* Fiber.join(late))._tag).toBe("Failure")
        }),
      )
    } finally {
      Deferred.doneUnsafe(release, Effect.void)
      await server.stop()
    }
  })

  it("rejects a session from another location before list or read RPCs", async () => {
    const server = fixture()
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup(rules)
          const manager = yield* MCPV2.Service
          yield* manager.admin.connect("fixture")
          const { db } = yield* Database.Service
          const foreignSessionID = SessionV2.ID.make("ses_mcp_foreign")
          const foreignDirectory = AbsolutePath.make(path.join(process.cwd(), "foreign-location"))
          yield* db
            .insert(SessionTable)
            .values({
              id: foreignSessionID,
              project_id: Project.ID.global,
              slug: foreignSessionID,
              directory: foreignDirectory,
              title: foreignSessionID,
              version: "test",
              agent: "build",
            })
            .run()
            .pipe(Effect.orDie)
          const foreign = { ...context(), sessionID: foreignSessionID }
          const missing = { ...context(), sessionID: SessionV2.ID.make("ses_mcp_missing") }
          expect((yield* Effect.result(manager.resources("fixture", { query: "report" }, foreign)))._tag).toBe(
            "Failure",
          )
          expect((yield* Effect.result(manager.read("fixture", uri, foreign)))._tag).toBe("Failure")
          expect((yield* Effect.result(manager.resources("fixture", { query: "report" }, missing)))._tag).toBe(
            "Failure",
          )
          expect((yield* Effect.result(manager.read("fixture", uri, missing)))._tag).toBe("Failure")
          expect(server.posts.filter((method) => method === "resources/list")).toHaveLength(0)
          expect(server.posts.filter((method) => method === "resources/read")).toHaveLength(0)
        }),
      )
    } finally {
      await server.stop()
    }
  })

  it("keeps long multiline resource text in an artifact that the actual read tool can page to the suffix", async () => {
    const server = fixture({ largeRead: true })
    try {
      await run(
        server.url,
        Effect.gen(function* () {
          yield* setup(rules)
          const registry = yield* ToolRegistry.Service
          const materialized = yield* registry.materialize([], sessionID)
          const connected = yield* materialized.settle(
            toolCall("mcp", { operation: "connect", server: "fixture" }, "call-mcp-connect"),
          )
          expect(connected.result.type).not.toBe("error")
          const output = yield* materialized.settle(
            toolCall("mcp", { operation: "read", server: "fixture", uri }, "call-mcp-read"),
          )
          expect(output.result.type).not.toBe("error")
          expect(output.contextSources).toMatchObject({ projection: "replaced", omitted: 0 })
          expect(output.outputPaths).toHaveLength(1)
          const artifactPath = output.outputPaths?.[0]
          if (!artifactPath) throw new Error("Expected the full MCP resource output artifact")

          const recovered = yield* materialized.settle(
            toolCall("read", { path: artifactPath, offset: 4_002, limit: 1 }, "call-read-artifact-suffix"),
          )
          expect(recovered.result.type).not.toBe("error")
          expect(JSON.stringify(recovered.output)).toContain("TAIL_TOKEN")
        }),
      )
    } finally {
      await server.stop()
    }
  })
})

function field(value: unknown, name: string): string {
  return Schema.decodeUnknownSync(Schema.Struct({ [name]: Schema.String }))(value)[name]!
}

function runtime(url: string) {
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({
              mcp: new ConfigMCP.Info({ servers: { fixture: new ConfigMCP.Remote({ type: "remote", url }) } }),
            }),
          }),
        ]),
    }),
  )
  const current = Layer.succeed(Location.Service, Location.Service.of({ ...location({ directory }) }))
  const database = Database.layerFromPath(":memory:")
  const store = LayerNode.compile(SessionStore.node, [[Database.node, database]])
  return AppNodeBuilder.build(
    LayerNode.group([
      MCPV2.node,
      MCPTool.node,
      ReadTool.node,
      ToolRegistry.node,
      AgentV2.node,
      Database.node,
      EventV2.node,
      PermissionV2.node,
    ]),
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
) {
  return Effect.runPromise(Effect.scoped(Effect.provide(program, runtime(url))))
}

function setup(permissions: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory,
        title: sessionID,
        version: "test",
        agent: "build",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(agent, (value) => {
        value.permissions = [...permissions]
      }),
    )
  })
}

function context() {
  return {
    sessionID,
    agent,
    assistantMessageID: SessionMessage.ID.make("msg_mcp_resources"),
    toolCallID: "call_mcp_resources",
  }
}

function toolCall(name: string, input: unknown, id: string) {
  return {
    sessionID,
    agent,
    assistantMessageID: SessionMessage.ID.make("msg_mcp_resources_settlement"),
    call: { type: "tool-call" as const, id, name, input },
  }
}

function readThroughTool(url: string) {
  return run(
    url,
    Effect.gen(function* () {
      yield* setup(rules)
      const registry = yield* ToolRegistry.Service
      const materialized = yield* registry.materialize([], sessionID)
      const connected = yield* materialized.settle(
        toolCall("mcp", { operation: "connect", server: "fixture" }, "call-connect"),
      )
      expect(connected.result.type).not.toBe("error")
      expect(connected.contextSources).toBeUndefined()
      return yield* materialized.settle(toolCall("mcp", { operation: "read", server: "fixture", uri }, "call-read"))
    }),
  )
}

type Request = {
  readonly id?: number | string
  readonly method: string
  readonly params?: { readonly uri?: string; readonly cursor?: string }
}

function fixture(
  options: {
    readonly resourceSupport?: boolean
    readonly toolSupport?: boolean
    readonly pageSize?: number
    readonly duplicateResources?: boolean
    readonly duplicateTemplates?: boolean
    readonly caseVariantResources?: boolean
    readonly resourceListFailure?: boolean
    readonly largeRead?: boolean
    readonly readContents?: MCPV2.ResourceResult["contents"]
    readonly beforeResourceList?: () => Promise<unknown>
  } = {},
) {
  const posts: string[] = []
  const readURIs: string[] = []
  let revision = 0
  let notified = false
  let readGate: (() => Promise<unknown>) | undefined
  const records = [
    { uri: "custom:report/alpha", name: "Quarterly report", description: "Report alpha", mimeType: "text/plain" },
    { uri: "custom:report/beta", name: "Annual report", description: "Report beta", mimeType: "text/plain" },
    { uri: "custom:report/gamma", name: "Report gamma", description: "Another report", mimeType: "application/json" },
    ...(options.caseVariantResources
      ? [{ uri: "CUSTOM:REPORT/ALPHA", name: "Case variant", description: "Report case", mimeType: "text/plain" }]
      : []),
    ...(options.duplicateResources
      ? [{ uri: "custom:report/alpha", name: "Duplicate URI", description: "Report duplicate", mimeType: "text/plain" }]
      : []),
  ]
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
            capabilities: {
              ...(options.resourceSupport === false ? {} : { resources: { listChanged: true, subscribe: true } }),
              ...(options.toolSupport === false ? {} : { tools: { listChanged: true } }),
            },
            serverInfo: { name: "resource-fixture", version: "1.0.0" },
          },
          true,
        )
      if (message.method === "resources/list") {
        if (options.beforeResourceList) await options.beforeResourceList()
        if (options.resourceListFailure) return new Response(null, { status: 500 })
        const size = options.pageSize ?? records.length
        const page = Number(message.params?.cursor ?? "0")
        const nextCursor = (page + 1) * size < records.length ? String(page + 1) : undefined
        const resources = records.slice(page * size, (page + 1) * size)
        const result = { resources, ...(nextCursor ? { nextCursor } : {}) }
        if (revision > 0 && !notified) {
          notified = true
          return Response.json(
            [
              { jsonrpc: "2.0", method: "notifications/resources/list_changed" },
              {
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  ...result,
                  resources: resources.map((item) => ({ ...item, description: `${item.description} updated` })),
                },
              },
            ],
            { headers: { "mcp-session-id": "resource-fixture-session" } },
          )
        }
        return response(message, result, true)
      }
      if (message.method === "tools/list")
        return response(
          message,
          {
            tools: [
              {
                name: "echo",
                description: "Echo",
                inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
              },
            ],
          },
          true,
        )
      if (message.method === "tools/call")
        return response(message, { content: [{ type: "text", text: "ok" }], structuredContent: { value: "ok" } }, true)
      if (message.method === "resources/templates/list")
        return response(
          message,
          {
            resourceTemplates: [
              {
                uriTemplate: "custom:report/{year}",
                name: "Yearly report",
                description: revision > 0 ? "A report by year updated" : "A report by year",
                mimeType: "text/plain",
              },
              ...(options.duplicateTemplates
                ? [
                    {
                      uriTemplate: "custom:report/{year}",
                      name: "Duplicate template",
                      description: "Duplicate report template",
                      mimeType: "text/plain",
                    },
                  ]
                : []),
            ],
          },
          true,
        )
      if (message.method === "resources/read") {
        readURIs.push(message.params?.uri ?? "")
        if (readGate) await readGate()
        const text = options.largeRead
          ? `${Array.from({ length: 4_000 }, (_, index) => `row-${String(index + 1).padStart(4, "0")}-${"x".repeat(24)}`).join("\n")}\nTAIL_TOKEN`
          : "hello"
        const contents =
          options.readContents ??
          (options.largeRead
            ? [{ uri: message.params?.uri, mimeType: "text/plain", text }]
            : [
                { uri: message.params?.uri, mimeType: "text/plain", text },
                { uri: message.params?.uri, mimeType: "application/octet-stream", blob: "aGVsbG8=" },
                { uri: message.params?.uri, mimeType: "text/plain", text: "world" },
              ])
        return response(
          message,
          {
            contents,
          },
          true,
        )
      }
      return new Response(null, { status: 202 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    posts,
    readURIs,
    changeResources: () => {
      revision++
    },
    gateRead: (gate: () => Promise<unknown>) => {
      readGate = gate
    },
    stop: () => server.stop(true),
  }
}

function response(message: Request, result: unknown, session = false) {
  return Response.json(
    { jsonrpc: "2.0", id: message.id, result },
    { headers: session ? { "mcp-session-id": "resource-fixture-session" } : undefined },
  )
}
