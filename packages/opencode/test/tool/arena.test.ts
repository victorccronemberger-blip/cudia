import { describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Database } from "@opencode-ai/core/database/database"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Agent } from "@/agent/agent"
import { BackgroundJob } from "@/background/job"
import { Command } from "@/command"
import { Config } from "@/config/config"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import { SessionRunState } from "@/session/run-state"
import { SessionStatus } from "@/session/status"
import { Skill } from "@/skill"
import { TaskTool, type TaskPromptOps } from "@/tool/task"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Agent.node,
      BackgroundJob.node,
      Command.node,
      Config.node,
      EventV2Bridge.node,
      CrossSpawnSpawner.node,
      Session.node,
      SessionProjector.node,
      SessionRunState.node,
      SessionStatus.node,
      Skill.node,
      Truncate.node,
      Database.node,
      RuntimeFlags.node,
      Ripgrep.node,
    ]),
  ),
)

describe("Arena native task contract", () => {
  it.instance(
    "discovers the slash skill and creates four candidates with the same briefing and available tools",
    () =>
      Effect.gen(function* () {
        const commands = yield* Command.Service
        const skills = yield* Skill.Service
        const agents = yield* Agent.Service
        const sessions = yield* Session.Service
        const contestant = yield* agents.get("arena-contestant")
        if (!contestant) throw new Error("Arena contestant was not discovered")
        expect(contestant.mode).toBe("subagent")
        expect(contestant.model).toBeUndefined()
        expect((yield* commands.get("arena"))?.source).toBe("skill")
        expect((yield* skills.require("arena")).name).toBe("arena")
        for (const permission of ["read", "glob", "grep", "webfetch", "skill", "edit", "bash", "execute", "task"]) {
          expect(Permission.evaluate(permission, "*", contestant.permission).action).toBe("allow")
        }
        expect(Permission.evaluate("claude-bridge_ask_claude", "*", contestant.permission).action).toBe("allow")

        const model = {
          providerID: ProviderV2.ID.make("test"),
          modelID: ModelV2.ID.make("arena-model"),
        }
        const parent = yield* sessions.create({ title: "Arena coordinator" })
        const assistant: SessionV1.Assistant = {
          id: MessageID.ascending(),
          role: "assistant",
          parentID: MessageID.ascending(),
          sessionID: parent.id,
          agent: "build",
          mode: "build",
          providerID: model.providerID,
          modelID: model.modelID,
          variant: "careful",
          cost: 0,
          path: { cwd: "/tmp", root: "/tmp" },
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now() },
        }
        yield* sessions.updateMessage(assistant)
        const briefing =
          "Propose a patch for the supplied bug. Do not edit files. Verify against the stated acceptance criteria."
        const seen: SessionID[] = []
        const promptOps: TaskPromptOps = {
          cancel: () => Effect.void,
          resolvePromptParts: (text) => Effect.succeed([{ type: "text", text }]),
          prompt: (input) =>
            Effect.gen(function* () {
              expect(input.agent).toBe("arena-contestant")
              expect(input.model).toEqual(model)
              expect(input.variant).toBe("careful")
              expect(input.parts).toEqual([{ type: "text", text: briefing }])
              expect(yield* sessions.messages({ sessionID: input.sessionID }).pipe(Effect.orDie)).toHaveLength(0)
              seen.push(input.sessionID)
              const message = { ...assistant, id: MessageID.ascending(), sessionID: input.sessionID }
              return {
                info: message,
                parts: [
                  {
                    id: PartID.ascending(),
                    messageID: message.id,
                    sessionID: input.sessionID,
                    type: "text",
                    text: "Candidate proposal",
                  },
                ],
              }
            }),
        }
        const task = yield* TaskTool
        const tool = yield* task.init()
        const results = yield* Effect.all(
          Array.from({ length: 4 }, (_, index) =>
            tool.execute(
              { description: `Arena candidate ${index + 1}`, prompt: briefing, subagent_type: "arena-contestant" },
              {
                sessionID: parent.id,
                messageID: assistant.id,
                agent: "build",
                abort: new AbortController().signal,
                messages: [],
                extra: { promptOps },
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            ),
          ),
          { concurrency: "unbounded" },
        )
        expect(seen).toHaveLength(4)
        expect(new Set(seen).size).toBe(4)
        expect(results.map((result) => result.metadata.sessionId).sort()).toEqual(seen.toSorted())
        const children = yield* sessions.children(parent.id)
        expect(children).toHaveLength(4)
        expect(children.every((child) => child.parentID === parent.id && child.agent === "arena-contestant")).toBe(true)
      }),
    {
      init: (directory) =>
        Effect.promise(async () => {
          const config = path.resolve(import.meta.dir, "../../../../.opencode")
          await Bun.write(
            path.join(directory, ".opencode/skills/arena/SKILL.md"),
            await Bun.file(path.join(config, "skills/arena/SKILL.md")).text(),
          )
          await Bun.write(
            path.join(directory, ".opencode/agent/arena-contestant.md"),
            await Bun.file(path.join(config, "agent/arena-contestant.md")).text(),
          )
        }),
    },
  )
})
