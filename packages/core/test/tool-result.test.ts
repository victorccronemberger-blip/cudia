import { describe, expect } from "bun:test"
import { eq, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigToolOutput } from "@opencode-ai/core/config/tool-output"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolResultTool } from "@opencode-ai/core/tool/tool-result"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { TextPage } from "@opencode-ai/core/util/text-page"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const sessionID = SessionV2.ID.make("ses_tool_result")
const messageID = SessionMessage.ID.make("msg_tool_result")
const callID = "call-result-source"
const projectDirectory = AbsolutePath.make("/project")
const locationRef = Location.Ref.make({ directory: projectDirectory })
const configuredBytes = 1_200
const it = testEffect(Layer.empty)
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const withRuntime = <A, E, R>(
  body: (runtime: Runtime) => Effect.Effect<A, E, R>,
  maxBytes = configuredBytes,
  afterRead?: (db: Database.Interface["db"]) => Effect.Effect<void>,
) =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => {
      const config = Layer.succeed(
        Config.Service,
        Config.Service.of({
          entries: () =>
            Effect.succeed([
              new Config.Document({
                type: "document",
                info: new Config.Info({
                  tool_output: new ConfigToolOutput.Info({ max_lines: 100, max_bytes: maxBytes }),
                }),
              }),
            ]),
        }),
      )
      const current = Layer.succeed(Location.Service, Location.Service.of(location(locationRef)))
      const database = Database.layerFromPath(":memory:")
      const outputStore = AppNodeBuilder.build(ToolOutputStore.node, [
        [Global.node, Global.layerWith({ data: tmp.path })],
        [Config.node, config],
      ])
      const decorated = afterRead
        ? Layer.effect(
            ToolOutputStore.Service,
            Effect.gen(function* () {
              const original = yield* ToolOutputStore.Service
              const db = (yield* Database.Service).db
              return ToolOutputStore.Service.of({
                ...original,
                page: (input) => original.page(input).pipe(Effect.tap(() => afterRead(db))),
              })
            }),
          ).pipe(Layer.provide(Layer.merge(outputStore, database)))
        : outputStore
      const runtime = AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          EventV2.node,
          AgentV2.node,
          PermissionSaved.node,
          PermissionV2.node,
          SessionStore.node,
          ToolOutputStore.node,
          ToolRegistry.node,
          ToolResultTool.node,
        ]),
        [
          [Global.node, Global.layerWith({ data: tmp.path })],
          [Config.node, config],
          [Location.node, current],
          [Database.node, database],
          [ToolOutputStore.node, decorated],
        ],
      )
      return Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db
          .insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: projectDirectory, sandboxes: [] })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: Project.ID.global,
            slug: sessionID,
            directory: projectDirectory,
            title: "tool result fixture",
            version: "test",
            agent: "build",
          })
          .run()
        const agents = yield* AgentV2.Service
        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("build"), (agent) => {
            agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
          }),
        )
        return yield* body({
          db,
          store: yield* SessionStore.Service,
          outputStore: yield* ToolOutputStore.Service,
          registry: yield* ToolRegistry.Service,
          agents,
          tmpPath: tmp.path,
        })
      }).pipe(Effect.provide(runtime))
    },
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  )

type Runtime = {
  db: Database.Interface["db"]
  store: SessionStore.Interface
  outputStore: ToolOutputStore.Interface
  registry: ToolRegistry.Interface
  agents: AgentV2.Interface
  tmpPath: string
}

const completed = (
  input: {
    readonly callID?: string
    readonly messageID?: SessionMessage.ID
    readonly state?: SessionMessage.AssistantTool["state"]
    readonly pruned?: boolean
  } = {},
) => {
  const created = DateTime.makeUnsafe(0)
  const resultMessageID = input.messageID ?? messageID
  const tool = {
    type: "tool" as const,
    id: input.callID ?? callID,
    name: "bash",
    state: input.state ?? {
      status: "completed" as const,
      input: {},
      structured: { answer: "structured 😀", count: 2 },
      content: [
        { type: "text" as const, text: "first 😀\nsecond" },
        { type: "file" as const, uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "pixel.png" },
      ],
    },
    time: { created, completed: created, ...(input.pruned ? { pruned: created } : {}) },
  }
  return SessionMessage.Assistant.make({
    id: resultMessageID,
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("test-model"), providerID: ProviderV2.ID.make("test-provider") },
    content: [tool],
    time: { created, completed: created },
  })
}

const insertMessage = (
  db: Database.Interface["db"],
  message: SessionMessage.Message,
  seq = 1,
  targetSessionID = sessionID,
) => {
  const encoded = encodeMessage(message) as Schema.Codec.Encoded<typeof SessionMessage.Message>
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: targetSessionID,
      type,
      seq,
      time_created: Date.now(),
      data,
    } as typeof SessionMessageTable.$inferInsert)
    .run()
}

const invoke = (registry: ToolRegistry.Interface, input: Record<string, unknown>) =>
  registry.materialize().pipe(
    Effect.flatMap((materialized) =>
      materialized.settle({
        sessionID,
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_tool_result_request"),
        call: {
          type: "tool-call",
          id: "call-tool-result-request",
          name: ToolResultTool.name,
          input,
        },
      }),
    ),
  )

const page = (settlement: ToolRegistry.Settlement) => {
  if (settlement.result.type !== "text") throw new Error(`Expected a text result, got ${settlement.result.type}`)
  if ((settlement.outputPaths?.length ?? 0) > 0) throw new Error("tool_result must not create a second retained output")
  return JSON.parse(String(settlement.result.value)) as {
    messageID: string
    callID: string
    source: string
    text: string
    offset: number
    nextOffset: number | null
    complete: boolean
    totalLength: number
    outputHash: string
    contentTextBounded: boolean
    captureTruncated: boolean | null
    attachmentCount: number
  }
}

describe("tool_result", () => {
  it.live("discards an admitted retained page when its session or tool state changes after reading", () =>
    Effect.gen(function* () {
      for (const mutation of ["delete", "move", "prune"] as const) {
        let reads = 0
        yield* withRuntime(
          ({ registry, db, outputStore }) =>
            Effect.gen(function* () {
              const retained = yield* outputStore.bound({
                sessionID,
                assistantMessageID: messageID,
                toolCallID: callID,
                output: { structured: {}, content: [{ type: "text", text: "retained source ".repeat(500) }] },
              })
              yield* insertMessage(
                db,
                completed({
                  state: {
                    status: "completed",
                    input: {},
                    structured: {},
                    content: retained.output.content,
                    outputPaths: retained.outputPaths,
                  },
                }),
              )
              const result = yield* invoke(registry, { callID, limit: 8 })
              expect(reads).toBe(1)
              expect(result.result).toMatchObject({
                type: "error",
                value:
                  mutation === "prune"
                    ? "Tool result is incomplete or was pruned"
                    : "Tool result session is unavailable at this location",
              })
              expect(result.output).toBeUndefined()
            }),
          configuredBytes,
          (db) =>
            Effect.gen(function* () {
              reads++
              if (mutation === "delete") {
                yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
                return
              }
              if (mutation === "move") {
                yield* db
                  .update(SessionTable)
                  .set({ directory: AbsolutePath.make("/moved") })
                  .where(eq(SessionTable.id, sessionID))
                  .run()
                  .pipe(Effect.orDie)
                return
              }
              const encoded = encodeMessage(completed({ pruned: true }))
              const { id, type, ...data } = encoded
              yield* db
                .update(SessionMessageTable)
                .set({ data })
                .where(eq(SessionMessageTable.id, SessionMessage.ID.make(id)))
                .run()
                .pipe(Effect.orDie)
            }),
        )
      }
    }),
  )

  it.live("registers as a native tool and pages each persisted source with exact JSON semantics", () =>
    withRuntime(({ registry, db }) =>
      Effect.gen(function* () {
        let executions = 0
        yield* registry.register({
          bash: Tool.make({
            description: "Fixture for proving tool_result does not rerun completed tools",
            input: Schema.Struct({}),
            output: Schema.Struct({ ran: Schema.Boolean }),
            execute: () =>
              Effect.sync(() => {
                executions++
                return { ran: true }
              }),
          }),
        })
        const materialized = yield* registry.materialize()
        const definition = materialized.definitions.find((tool) => tool.name === ToolResultTool.name)
        expect(definition).toBeDefined()
        const definitionBytes = Buffer.byteLength(JSON.stringify(definition))
        expect(definitionBytes).toBeGreaterThan(0)
        expect(materialized.definitions.map((tool) => tool.name).sort()).toEqual(["bash", ToolResultTool.name].sort())

        yield* insertMessage(db, completed())
        const text = page(yield* invoke(registry, { callID }))
        expect(text).toMatchObject({
          messageID,
          callID,
          source: "text",
          text: "first 😀\nsecond",
          offset: 0,
          nextOffset: null,
          complete: true,
          totalLength: "first 😀\nsecond".length,
          contentTextBounded: false,
          captureTruncated: null,
          attachmentCount: 1,
        })
        const structured = page(yield* invoke(registry, { callID, source: "structured" }))
        expect(structured.text).toBe(JSON.stringify({ answer: "structured 😀", count: 2 }))
        expect(structured.outputHash).not.toBe(text.outputHash)
        const content = page(yield* invoke(registry, { callID, source: "content" }))
        expect(content.text).toBe(
          JSON.stringify([
            { type: "text", text: "first 😀\nsecond" },
            { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "pixel.png" },
          ]),
        )
        const structuredOnlyID = SessionMessage.ID.make("msg_tool_result_structured_only")
        yield* insertMessage(
          db,
          completed({
            callID: "call-structured-only",
            messageID: structuredOnlyID,
            state: { status: "completed", input: {}, structured: { only: "JSON", count: 2 }, content: [] },
          }),
          2,
        )
        expect(page(yield* invoke(registry, { callID: "call-structured-only" })).text).toBe(
          JSON.stringify({ only: "JSON", count: 2 }, null, 2),
        )
        expect(executions).toBe(0)
        const textOnly = completed({
          callID: "call-nul-text",
          messageID: SessionMessage.ID.make("msg_tool_result_nul_text"),
          state: {
            status: "completed",
            input: {},
            structured: {},
            content: [{ type: "text", text: "\u0000recoverable" }],
          },
        })
        expect(ToolResultTool.available([textOnly])).toBe(true)
        expect(
          ToolResultTool.available([
            completed({
              callID: "call-pruned-text",
              state: { status: "completed", input: {}, structured: {}, content: [{ type: "text", text: "text" }] },
              pruned: true,
            }),
          ]),
        ).toBe(false)
      }),
    ),
  )

  it.live("retains and exactly pages a long single-line result while bounding the complete JSON envelope", () =>
    withRuntime(({ outputStore, registry, db }) =>
      Effect.gen(function* () {
        const original = `quote\\\"\t😀\u0000é`.repeat(600)
        const blob = {
          type: "file" as const,
          uri: `data:image/png;base64,${"b".repeat(2_000)}`,
          mime: "image/png",
          name: "pixel.png",
        }
        const retained = yield* outputStore.bound({
          sessionID,
          assistantMessageID: messageID,
          toolCallID: callID,
          output: {
            structured: { truncated: true, json: original },
            content: [{ type: "text", text: original }, blob],
          },
        })
        expect(retained.outputPaths).toHaveLength(1)
        yield* insertMessage(
          db,
          completed({
            state: {
              status: "completed",
              input: {},
              structured: { truncated: true, json: original },
              content: retained.output.content,
              outputPaths: retained.outputPaths,
            },
          }),
        )

        const pieces: string[] = []
        let offset = 0
        let outputHash: string | undefined
        while (true) {
          const result = yield* invoke(registry, {
            callID,
            offset,
            limit: TextPage.MAX_UNITS,
            ...(outputHash ? { outputHash } : {}),
          })
          const next = page(result)
          expect(
            Buffer.byteLength(result.result.type === "text" ? String(result.result.value) : ""),
          ).toBeLessThanOrEqual(configuredBytes)
          expect(result.outputPaths ?? []).toEqual([])
          expect(next.contentTextBounded).toBe(true)
          expect(next.captureTruncated).toBe(true)
          expect(next.offset).toBe(offset)
          outputHash ??= next.outputHash
          pieces.push(next.text)
          if (next.nextOffset === null) {
            expect(next.complete).toBe(true)
            break
          }
          expect(next.nextOffset).toBeGreaterThan(offset)
          offset = next.nextOffset
        }
        expect(pieces.join("")).toBe(original)

        const readSource = (source: "structured" | "content") =>
          Effect.gen(function* () {
            const sourcePieces: string[] = []
            let sourceOffset = 0
            let sourceHash: string | undefined
            while (true) {
              const result = yield* invoke(registry, {
                callID,
                source,
                offset: sourceOffset,
                limit: TextPage.MAX_UNITS,
                ...(sourceHash ? { outputHash: sourceHash } : {}),
              })
              const snapshot = page(result)
              expect(
                Buffer.byteLength(result.result.type === "text" ? String(result.result.value) : ""),
              ).toBeLessThanOrEqual(configuredBytes)
              expect(result.outputPaths ?? []).toEqual([])
              sourceHash ??= snapshot.outputHash
              sourcePieces.push(snapshot.text)
              if (snapshot.nextOffset === null) return sourcePieces.join("")
              sourceOffset = snapshot.nextOffset
            }
          })

        expect(yield* readSource("structured")).toBe(JSON.stringify({ truncated: true, json: original }))
        expect(yield* readSource("content")).toBe(JSON.stringify(retained.output.content))
      }),
    ),
  )
  ;(it.live("fails when the configured budget cannot fit the complete page envelope", () =>
    withRuntime(
      ({ registry, db }) =>
        Effect.gen(function* () {
          yield* insertMessage(db, completed())
          const result = yield* invoke(registry, { callID })
          expect(result.result).toMatchObject({
            type: "error",
            value: expect.stringContaining("budget"),
          })
          expect(result.outputPaths ?? []).toEqual([])
        }),
      128,
    ),
  ),
    it.live(
      "requires a source-bound hash for continuation and rejects stale, split-surrogate, and past-EOF offsets",
      () =>
        withRuntime(({ registry, db }) =>
          Effect.gen(function* () {
            yield* insertMessage(db, completed())
            const first = page(yield* invoke(registry, { callID }))
            expect((yield* invoke(registry, { callID, offset: 1 })).result).toMatchObject({
              type: "error",
              value: expect.stringContaining("outputHash is required"),
            })
            expect(
              (yield* invoke(registry, { callID, source: "structured", offset: 1, outputHash: first.outputHash }))
                .result,
            ).toMatchObject({
              type: "error",
              value: expect.stringContaining("outputHash belongs to a different source"),
            })
            expect((yield* invoke(registry, { callID, offset: 7, outputHash: first.outputHash })).result).toMatchObject(
              {
                type: "error",
                value: expect.stringContaining("surrogate"),
              },
            )
            expect(
              (yield* invoke(registry, { callID, offset: first.totalLength + 1, outputHash: first.outputHash })).result,
            ).toMatchObject({
              type: "error",
              value: expect.stringContaining("offset exceeds"),
            })
            expect(
              page(yield* invoke(registry, { callID, offset: first.totalLength, outputHash: first.outputHash })),
            ).toMatchObject({
              text: "",
              nextOffset: null,
              complete: true,
            })

            const changed = encodeMessage(
              completed({
                state: {
                  status: "completed",
                  input: {},
                  structured: { answer: "changed" },
                  content: [{ type: "text", text: "changed result" }],
                },
              }),
            ) as Schema.Codec.Encoded<typeof SessionMessage.Message>
            const { id, type: _, ...data } = changed
            yield* db.run(sql`UPDATE session_message SET data = ${JSON.stringify(data)} WHERE id = ${id}`)
            expect((yield* invoke(registry, { callID, offset: 1, outputHash: first.outputHash })).result).toMatchObject(
              {
                type: "error",
                value: expect.stringContaining("outputHash belongs to a different source"),
              },
            )
          }),
        ),
    ))

  it.live("ignores legacy deny records and rejects duplicate call IDs unless messageID disambiguates", () =>
    withRuntime(({ registry, db, agents, store }) =>
      Effect.gen(function* () {
        yield* insertMessage(db, completed({ messageID: SessionMessage.ID.make("msg_tool_result_first") }))
        yield* insertMessage(db, completed({ messageID: SessionMessage.ID.make("msg_tool_result_second") }), 2)
        const base = completed({
          callID: "call-inside-message",
          messageID: SessionMessage.ID.make("msg_tool_result_inside"),
        })
        yield* insertMessage(
          db,
          SessionMessage.Assistant.make({
            ...base,
            content: [base.content[0]!, base.content[0]!],
          }),
          3,
        )
        const deniedRules = [
          { action: "read", resource: "*", effect: "allow" as const },
          { action: "*", resource: "*", effect: "deny" as const },
        ]
        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("build"), (agent) => {
            agent.permissions = deniedRules
          }),
        )
        const denied = yield* registry.materialize([], sessionID).pipe(
          Effect.flatMap((materialized) =>
            materialized.settle({
              sessionID,
              agent: AgentV2.ID.make("build"),
              assistantMessageID: SessionMessage.ID.make("msg_denied_request"),
              call: { type: "tool-call", id: "call-denied", name: ToolResultTool.name, input: { callID: "missing" } },
            }),
          ),
        )
        expect(denied.result).toMatchObject({ type: "error", value: "Tool result was not found" })
        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("build"), (agent) => {
            agent.permissions = [{ action: "*", resource: "*", effect: "allow" }]
          }),
        )
        expect((yield* invoke(registry, { callID })).result).toMatchObject({
          type: "error",
          value: expect.stringContaining("Ambiguous callID"),
        })
        expect((yield* store.toolMessages(sessionID, callID)).map((message) => String(message.id))).toEqual(
          ["msg_tool_result_first", "msg_tool_result_second"].sort(),
        )
        expect(page(yield* invoke(registry, { callID, messageID: "msg_tool_result_second" }))).toMatchObject({
          messageID: "msg_tool_result_second",
          text: "first 😀\nsecond",
        })
        expect((yield* invoke(registry, { callID: "missing" })).result).toMatchObject({
          type: "error",
          value: "Tool result was not found",
        })
        expect((yield* invoke(registry, { callID: "call-inside-message" })).result).toMatchObject({
          type: "error",
          value: expect.stringContaining("Ambiguous callID"),
        })

        const events = yield* EventV2.Service
        const asked: string[] = []
        const unsubscribe = yield* events.listen((event) =>
          Effect.sync(() => {
            if (event.type === PermissionV2.Event.Asked.type) asked.push(event.type)
          }),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("build"), (agent) => {
            agent.permissions = [{ action: "*", resource: "*", effect: "ask" }]
          }),
        )
        expect((yield* invoke(registry, { callID: "not-yet-looked-up" })).result).toMatchObject({
          type: "error",
          value: "Tool result was not found",
        })
        expect(page(yield* invoke(registry, { callID, messageID: "msg_tool_result_second" })).text).toBe(
          "first 😀\nsecond",
        )
        const permissions = yield* PermissionV2.Service
        expect(yield* permissions.list()).toEqual([])
        expect(asked).toEqual([])
      }),
    ),
  )

  it.live("rejects cross-session, incomplete, and pruned results", () =>
    withRuntime(({ registry, db, store }) =>
      Effect.gen(function* () {
        expect(yield* store.hasRecoverableToolResult(sessionID)).toBe(false)
        yield* insertMessage(
          db,
          completed({
            callID: "call-pending",
            messageID: SessionMessage.ID.make("msg_tool_result_pending"),
            state: {
              status: "running",
              input: {},
              structured: {},
              content: [],
            },
          }),
          1,
        )
        yield* insertMessage(
          db,
          completed({
            callID: "call-pruned",
            messageID: SessionMessage.ID.make("msg_tool_result_pruned"),
            pruned: true,
          }),
          2,
        )
        expect((yield* invoke(registry, { callID: "call-pending" })).result).toMatchObject({
          type: "error",
          value: "Tool result is incomplete or was pruned",
        })
        expect((yield* invoke(registry, { callID: "call-pruned" })).result).toMatchObject({
          type: "error",
          value: "Tool result is incomplete or was pruned",
        })
        expect(yield* store.hasRecoverableToolResult(sessionID)).toBe(false)

        const otherSessionID = SessionV2.ID.make("ses_tool_result_other")
        yield* db
          .insert(SessionTable)
          .values({
            id: otherSessionID,
            project_id: Project.ID.global,
            slug: otherSessionID,
            directory: projectDirectory,
            title: "other session",
            version: "test",
            agent: "build",
          })
          .run()
        const foreignMessageID = SessionMessage.ID.make("msg_tool_result_foreign")
        yield* insertMessage(db, completed({ messageID: foreignMessageID }), 1, otherSessionID)
        expect(yield* store.hasRecoverableToolResult(otherSessionID)).toBe(true)
        expect(yield* store.hasRecoverableToolResult(sessionID)).toBe(false)
        expect((yield* invoke(registry, { callID, messageID: foreignMessageID })).result).toMatchObject({
          type: "error",
          value: "Tool result does not belong to this session",
        })

        const oldMessageID = SessionMessage.ID.make("msg_tool_result_before_compaction")
        yield* insertMessage(
          db,
          completed({
            callID: "call-before-compaction",
            messageID: oldMessageID,
            state: {
              status: "completed",
              input: {},
              structured: {},
              content: [{ type: "text", text: "\u0000recover me" }],
            },
          }),
          3,
        )
        const created = DateTime.makeUnsafe(3)
        const compaction = SessionMessage.Compaction.make({
          id: SessionMessage.ID.make("msg_tool_result_compaction"),
          type: "compaction",
          reason: "manual",
          summary: "Summary",
          recent: "Recent",
          time: { created },
        })
        yield* insertMessage(db, compaction, 4)
        expect(yield* store.hasRecoverableToolResult(sessionID)).toBe(true)
        expect((yield* store.toolMessages(sessionID, "call-before-compaction")).map((message) => message.id)).toEqual([
          oldMessageID,
        ])
        yield* insertMessage(
          db,
          completed({
            callID: "call-before-compaction",
            messageID: SessionMessage.ID.make("msg_tool_result_pending_old_call"),
            state: { status: "running", input: {}, structured: {}, content: [] },
          }),
          5,
        )
        expect(
          (yield* store.toolMessages(sessionID, "call-before-compaction")).map((message) => String(message.id)).sort(),
        ).toEqual(["msg_tool_result_before_compaction", "msg_tool_result_pending_old_call"])
        expect((yield* invoke(registry, { callID: "call-before-compaction" })).result).toMatchObject({
          type: "error",
          value: expect.stringContaining("Ambiguous callID"),
        })

        yield* db
          .update(SessionTable)
          .set({ directory: AbsolutePath.make("/elsewhere") })
          .where(eq(SessionTable.id, sessionID))
          .run()
        expect((yield* invoke(registry, { callID: "call-before-compaction" })).result).toMatchObject({
          type: "error",
          value: "Tool result session is unavailable at this location",
        })
      }),
    ),
  )
})
