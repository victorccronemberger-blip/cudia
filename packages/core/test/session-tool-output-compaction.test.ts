import { createHash } from "node:crypto"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ModelV2 } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { MessageTable, PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const outputHash = (output: string) => createHash("sha256").update(JSON.stringify(output)).digest("hex")

const insertSession = (db: Database.Interface["db"], sessionID: SessionV2.ID) =>
  Effect.gen(function* () {
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .run()
  })

const insertToolPart = (
  db: Database.Interface["db"],
  sessionID: SessionV2.ID,
  messageID: SessionV1.MessageID,
  partID: SessionV1.PartID,
  output: string,
) =>
  Effect.gen(function* () {
    yield* db.insert(MessageTable).values({
      id: messageID,
      session_id: sessionID,
      time_created: 0,
      data: {
        role: "assistant",
        time: { created: 0, completed: 1 },
        parentID: SessionV1.MessageID.ascending("msg_parent"),
        modelID: ModelV2.ID.make("model"),
        providerID: ProviderV2.ID.make("provider"),
        mode: "build",
        agent: "build",
        path: { cwd: "/project", root: "/project" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    } as typeof MessageTable.$inferInsert)
    yield* db.insert(PartTable).values({
      id: partID,
      session_id: sessionID,
      message_id: messageID,
      time_created: 0,
      data: {
        type: "tool",
        callID: "call-1",
        tool: "bash",
        state: {
          status: "completed",
          input: {},
          output,
          title: "bash",
          metadata: { marker: "original" },
          time: { start: 0, end: 1 },
        },
      },
    } as typeof PartTable.$inferInsert)
  })

describe("SessionV1 tool output compaction projection", () => {
  it.effect("marks only the matching recorded output and preserves current metadata", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const sessionID = SessionV2.ID.make("ses_tool_compact_metadata")
      const messageID = SessionV1.MessageID.ascending("msg_tool_compact_metadata")
      const partID = SessionV1.PartID.ascending("prt_tool_compact_metadata")
      const output = "recorded output"
      yield* insertSession(db, sessionID)
      yield* insertToolPart(db, sessionID, messageID, partID, output)

      const events = yield* EventV2.Service
      const updatedPart = {
        id: partID,
        sessionID,
        messageID,
        type: "tool" as const,
        callID: "call-1",
        tool: "bash",
        state: {
          status: "completed" as const,
          input: {},
          output,
          title: "new title",
          metadata: { marker: "latest metadata" },
          time: { start: 0, end: 1 },
        },
      }
      yield* events.publish(SessionV1.Event.PartUpdated, { sessionID, part: updatedPart, time: 2 })
      yield* db.run(
        sql`UPDATE part SET data = json_set(json_set(data, '$.futureTopLevel', 'preserve-me'), '$.state.time.futureClock', 'opaque-time') WHERE id = ${partID}`,
      )
      yield* events.publish(SessionV1.Event.ToolOutputCompacted, {
        sessionID,
        messageID,
        partID,
        tool: "bash",
        outputHash: outputHash(output),
        time: 3,
      })

      expect(yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get()).toMatchObject({
        session_id: sessionID,
        message_id: messageID,
        data: {
          futureTopLevel: "preserve-me",
          type: "tool",
          tool: "bash",
          state: {
            output,
            title: "new title",
            metadata: { marker: "latest metadata" },
            time: { start: 0, end: 1, compacted: 3, futureClock: "opaque-time" },
          },
        },
      })
    }),
  )

  it.effect("ignores stale output hashes, including a hash made from a lone surrogate", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const sessionID = SessionV2.ID.make("ses_tool_compact_stale")
      const messageID = SessionV1.MessageID.ascending("msg_tool_compact_stale")
      const partID = SessionV1.PartID.ascending("prt_tool_compact_stale")
      const originalOutput = "old output"
      const currentOutput = "new output"
      yield* insertSession(db, sessionID)
      yield* insertToolPart(db, sessionID, messageID, partID, originalOutput)

      const events = yield* EventV2.Service
      yield* events.publish(SessionV1.Event.PartUpdated, {
        sessionID,
        part: {
          id: partID,
          sessionID,
          messageID,
          type: "tool",
          callID: "call-1",
          tool: "bash",
          state: {
            status: "completed",
            input: {},
            output: currentOutput,
            title: "bash",
            metadata: { marker: "latest" },
            time: { start: 0, end: 2 },
          },
        },
        time: 2,
      })
      yield* events.publish(SessionV1.Event.ToolOutputCompacted, {
        sessionID,
        messageID,
        partID,
        tool: "bash",
        outputHash: outputHash(originalOutput),
        time: 3,
      })

      const stale = yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get()
      expect(stale?.data).toMatchObject({
        state: { output: currentOutput, metadata: { marker: "latest" }, time: { start: 0, end: 2 } },
      })
      expect(stale?.data).not.toHaveProperty("state.time.compacted")

      const surrogateID = SessionV1.PartID.ascending("prt_tool_compact_surrogate")
      const surrogateOutput = "\ud800"
      yield* insertToolPart(
        db,
        sessionID,
        SessionV1.MessageID.ascending("msg_tool_compact_surrogate"),
        surrogateID,
        surrogateOutput,
      )
      const rawStringHash = createHash("sha256").update(surrogateOutput).digest("hex")
      yield* events.publish(SessionV1.Event.ToolOutputCompacted, {
        sessionID,
        messageID: SessionV1.MessageID.ascending("msg_tool_compact_surrogate"),
        partID: surrogateID,
        tool: "bash",
        outputHash: rawStringHash,
        time: 4,
      })
      const surrogate = yield* db.select().from(PartTable).where(eq(PartTable.id, surrogateID)).get()
      expect(surrogate?.data).toMatchObject({ state: { output: surrogateOutput, time: { start: 0, end: 1 } } })
      expect(surrogate?.data).not.toHaveProperty("state.time.compacted")
      yield* events.publish(SessionV1.Event.ToolOutputCompacted, {
        sessionID,
        messageID: SessionV1.MessageID.ascending("msg_tool_compact_surrogate"),
        partID: surrogateID,
        tool: "bash",
        outputHash: outputHash(surrogateOutput),
        time: 5,
      })
      expect((yield* db.select().from(PartTable).where(eq(PartTable.id, surrogateID)).get())?.data).toMatchObject({
        state: { output: surrogateOutput, time: { start: 0, end: 1, compacted: 5 } },
      })
    }),
  )

  it.effect("does not recreate a deleted part and makes repeated events idempotent", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const sessionID = SessionV2.ID.make("ses_tool_compact_deleted")
      const messageID = SessionV1.MessageID.ascending("msg_tool_compact_deleted")
      const partID = SessionV1.PartID.ascending("prt_tool_compact_deleted")
      const output = "kept in storage"
      yield* insertSession(db, sessionID)
      yield* insertToolPart(db, sessionID, messageID, partID, output)
      const events = yield* EventV2.Service
      const payload = { sessionID, messageID, partID, tool: "bash", outputHash: outputHash(output), time: 5 }

      yield* events.publish(SessionV1.Event.ToolOutputCompacted, {
        ...payload,
        messageID: SessionV1.MessageID.ascending("msg_foreign"),
      })
      yield* events.publish(SessionV1.Event.ToolOutputCompacted, {
        ...payload,
        sessionID: SessionV2.ID.make("ses_foreign"),
      })
      expect((yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get())?.data).not.toHaveProperty(
        "state.time.compacted",
      )

      yield* events.publish(SessionV1.Event.ToolOutputCompacted, payload)
      yield* events.publish(SessionV1.Event.ToolOutputCompacted, { ...payload, time: 6 })
      expect((yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get())?.data).toMatchObject({
        state: { output, time: { compacted: 5 } },
      })

      yield* events.publish(SessionV1.Event.PartRemoved, { sessionID, messageID, partID })
      yield* events.publish(SessionV1.Event.ToolOutputCompacted, { ...payload, time: 7 })
      expect(yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get()).toBeUndefined()

      const foreignPart = SessionV1.PartID.ascending("prt_tool_compact_foreign")
      yield* events.publish(SessionV1.Event.ToolOutputCompacted, { ...payload, partID: foreignPart, time: 8 })
      expect(yield* db.select().from(PartTable).where(eq(PartTable.id, foreignPart)).get()).toBeUndefined()
    }),
  )

  it.effect("rolls back the projected timestamp and emits no notification when commit fails", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const db = database.db
      const sessionID = SessionV2.ID.make("ses_tool_compact_rollback")
      const messageID = SessionV1.MessageID.ascending("msg_tool_compact_rollback")
      const partID = SessionV1.PartID.ascending("prt_tool_compact_rollback")
      const output = "rollback output"
      yield* insertSession(db, sessionID)
      yield* insertToolPart(db, sessionID, messageID, partID, output)

      const events = yield* EventV2.Service
      const received = new Array<string>()
      yield* events.listen((event) => Effect.sync(() => received.push(event.type)))
      const exit = yield* events
        .publish(
          SessionV1.Event.ToolOutputCompacted,
          { sessionID, messageID, partID, tool: "bash", outputHash: outputHash(output), time: 9 },
          { commit: () => Effect.die("fixture commit failed") },
        )
        .pipe(Effect.exit)

      expect(String(exit)).toContain("fixture commit failed")
      const part = yield* db.select().from(PartTable).where(eq(PartTable.id, partID)).get()
      expect(part?.data).toMatchObject({ state: { output, time: { start: 0, end: 1 } } })
      expect(part?.data).not.toHaveProperty("state.time.compacted")
      expect(yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()).toEqual([])
      expect(received).toEqual([])
    }),
  )
})
