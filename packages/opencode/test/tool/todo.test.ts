import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Todo } from "@/session/todo"
import { MessageID } from "@/session/schema"
import { TodoWriteTool } from "@/tool/todo"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Session.node,
      SessionProjector.node,
      Todo.node,
      Agent.node,
      Truncate.node,
      CrossSpawnSpawner.node,
    ]),
  ),
)

describe("tool.todowrite", () => {
  it.instance("replaces ordered todos, accepts concurrent and custom states, and clears the list", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const todos = yield* Todo.Service
      const session = yield* sessions.create()
      const definition = yield* TodoWriteTool
      const tool = yield* definition.init()
      const ctx: Tool.Context = {
        sessionID: session.id,
        messageID: MessageID.ascending(),
        callID: "todo-contract",
        agent: "build",
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: () => Effect.void,
      }
      const initial = [
        { content: "First", status: "in_progress", priority: "high" },
        { content: "Second", status: "in_progress", priority: "normal" },
        { content: "Third", status: "waiting_for_input", priority: "custom" },
      ]
      const result = yield* tool.execute({ todos: initial }, ctx)
      expect(JSON.parse(result.output)).toEqual(initial)
      expect(yield* todos.get(session.id)).toEqual(initial)

      const replacement = [initial[2], { ...initial[0], status: "completed" }]
      yield* tool.execute({ todos: replacement }, ctx)
      expect(yield* todos.get(session.id)).toEqual(replacement)

      const cleared = yield* tool.execute({ todos: [] }, ctx)
      expect(JSON.parse(cleared.output)).toEqual([])
      expect(yield* todos.get(session.id)).toEqual([])
    }),
  )
})
