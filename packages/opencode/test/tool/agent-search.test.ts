import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Cause, Effect, Exit, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { HarnessPolicy } from "@opencode-ai/core/harness/policy"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Session } from "@/session/session"
import { ToolRegistry } from "@/tool/registry"
import { TaskTool } from "@/tool/task"
import { AgentSearchTool } from "@/tool/agent-search"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      ToolRegistry.node,
      Agent.node,
      CrossSpawnSpawner.node,
      Ripgrep.node,
      Session.node,
      SessionProjector.node,
    ]),
    [
      [
        HarnessPolicy.node,
        Layer.succeed(HarnessPolicy.Service, HarnessPolicy.Service.of({ contextMode: "standard", auditMode: "off" })),
      ],
    ],
  ),
)

describe("tool.agent_search", () => {
  it.instance("searches nonhidden subagent metadata despite legacy caller and session denies", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const home = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = test.directory
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.OPENCODE_TEST_HOME = home
        }),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(test.directory, ".opencode", "opencode.json"),
          JSON.stringify({
            permission: { task: { "caller-denied": "deny" } },
            agent: {
              "search-alpha": { mode: "subagent", description: "Find alpha data", prompt: "SECRET ALPHA PROMPT" },
              "search-beta": { mode: "subagent", description: "Find beta records", prompt: "SECRET BETA PROMPT" },
              "caller-denied": { mode: "subagent", description: "Must stay hidden from search" },
              "search-hidden": { mode: "subagent", hidden: true, description: "Hidden description" },
              "search-primary": { mode: "primary", description: "Primary description" },
              "long-agent": { mode: "subagent", description: "界🙂".repeat(800) },
            },
          }),
        ),
      )

      const agents = yield* Agent.Service
      const caller = yield* agents.get("build")
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        permission: Permission.fromConfig({ task: { "search-beta": "deny", explore: "deny" } }),
      })
      const registry = yield* ToolRegistry.Service
      const tools = yield* registry.tools({
        providerID: ProviderV2.ID.opencode,
        modelID: ModelV2.ID.make("test-model"),
        agent: caller,
      })
      const search = tools.find((tool) => tool.id === AgentSearchTool.id)
      const task = tools.find((tool) => tool.id === TaskTool.id)
      if (!search || !task) throw new Error("Expected agent search and task tools")

      const asks: unknown[] = []
      const ctx = {
        sessionID: session.id,
        messageID: "msg_agent_search_test" as never,
        agent: caller.name,
        abort: AbortSignal.any([]),
        messages: [],
        metadata: () => Effect.void,
        ask: (request: unknown) => Effect.sync(() => asks.push(request)),
      }
      const result = yield* search.execute({ query: "alpha" }, ctx)
      const parsed = JSON.parse(result.output)
      expect(parsed.matches.map((item: { name: string }) => item.name)).toContain("search-alpha")
      expect(parsed.matches.map((item: { name: string }) => item.name)).not.toContain("search-hidden")
      expect(parsed.matches.map((item: { name: string }) => item.name)).not.toContain("search-primary")
      expect(result.output).not.toContain("SECRET ALPHA PROMPT")
      expect(result.output).not.toContain("SECRET BETA PROMPT")
      expect(asks).toHaveLength(0)
      for (const [query, name] of [
        ["beta", "search-beta"],
        ["caller-denied", "caller-denied"],
        ["explore", "explore"],
      ]) {
        const found = yield* search.execute({ query }, ctx)
        expect(JSON.parse(found.output).matches.map((item: { name: string }) => item.name)).toContain(name)
      }
      for (const query of ["search-hidden", "search-primary"]) {
        const unavailable = yield* search.execute({ query }, ctx)
        expect(JSON.parse(unavailable.output).matches).toHaveLength(0)
      }

      const page = yield* search.execute({ query: "", limit: 2 }, ctx)
      const first = JSON.parse(page.output)
      expect(first.matches).toHaveLength(2)
      expect(first.nextOffset).toBeDefined()
      const secondPage = yield* search.execute({ query: "", limit: 2, offset: first.nextOffset }, ctx)
      expect(JSON.parse(secondPage.output).matches[0].name).not.toBe(first.matches[0].name)
      expect(Buffer.byteLength(page.output)).toBeLessThanOrEqual(6_000)

      const long = yield* search.execute({ query: "long-agent" }, ctx)
      expect(Buffer.byteLength(long.output)).toBeLessThanOrEqual(6_000)
      expect(long.output).not.toContain("SECRET")
      expect(JSON.parse(long.output).matches[0].description.length).toBeLessThanOrEqual(400)

      expect(task.parameters).toBeDefined()
      expect(asks).toHaveLength(0)
      const missingAgent = yield* search.execute({ query: "x" }, { ...ctx, agent: "missing" }).pipe(Effect.exit)
      expect(Exit.isFailure(missingAgent)).toBe(true)
      if (Exit.isFailure(missingAgent)) expect(Cause.squash(missingAgent.cause)).toBeInstanceOf(Error)
    }),
  )
})
