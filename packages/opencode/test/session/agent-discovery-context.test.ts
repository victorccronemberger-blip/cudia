import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { HarnessPolicy } from "@opencode-ai/core/harness/policy"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Permission } from "@/permission"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"

let contextMode: HarnessPolicy.Interface["contextMode"] = "standard"
let catalog: Agent.Info[] = []
const definitionHooks = new Set<string>()
const caller: Agent.Info = {
  name: "build",
  mode: "primary",
  native: true,
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}
const configLayer = TestConfig.layer({
  directories: () => InstanceState.directory.pipe(Effect.map((dir) => [`${dir}/.opencode`])),
})
const agentLayer = Layer.mock(Agent.Service, {
  get: (name) => Effect.succeed(name === caller.name ? caller : (undefined as never)),
  list: () => Effect.succeed(catalog),
})
const policyLayer = Layer.succeed(
  HarnessPolicy.Service,
  HarnessPolicy.Service.of({
    get contextMode() {
      return contextMode
    },
    auditMode: "off",
  }),
)
const pluginLayer = Layer.mock(Plugin.Service, {
  list: () => Effect.succeed([]),
  init: () => Effect.void,
  trigger: (name, input, output) =>
    Effect.sync(() => {
      if (name === "tool.definition") definitionHooks.add((input as { toolID: string }).toolID)
      return output
    }),
})
const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, Agent.node]), [
    [Config.node, configLayer],
    [RuntimeFlags.node, RuntimeFlags.layer()],
    [Agent.node, agentLayer],
    [Plugin.node, pluginLayer],
    [HarnessPolicy.node, policyLayer],
  ]),
)

function fixtureAgents(count: number): Agent.Info[] {
  return [
    {
      name: "hidden-worker",
      mode: "subagent",
      hidden: true,
      description: "Hidden metadata fixture",
      permission: [],
      options: {},
    },
    ...Array.from({ length: count }, (_, index) => ({
      name: `worker-${index + 1}`,
      mode: "subagent" as const,
      description: `Handles specialized repository investigation number ${index + 1}.`,
      permission: [],
      options: {},
    })),
  ]
}

describe("agent discovery context size", () => {
  it.instance("keeps lean task definitions independent of catalog size", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const getDefinitions = Effect.fnUntraced(function* () {
        const tools = yield* registry.tools({
          providerID: ProviderV2.ID.opencode,
          modelID: ModelV2.ID.make("test-model"),
          agent: caller,
        })
        const serialized = Object.fromEntries(
          tools.map((tool) => [tool.id, { description: tool.description, inputSchema: ToolJsonSchema.fromTool(tool) }]),
        )
        return { tools, serialized, bytes: Buffer.byteLength(JSON.stringify(serialized)) }
      })

      catalog = fixtureAgents(3)
      contextMode = "standard"
      const standardSmall = yield* getDefinitions()
      contextMode = "lean"
      const leanSmall = yield* getDefinitions()

      catalog = fixtureAgents(120)
      contextMode = "standard"
      const standardLarge = yield* getDefinitions()
      contextMode = "lean"
      const leanLarge = yield* getDefinitions()

      const addedDefinitionOverhead = (result: typeof leanSmall) => {
        const definitions = { ...result.serialized }
        delete definitions.agent_search
        delete definitions.tool_result
        return result.bytes - Buffer.byteLength(JSON.stringify(definitions))
      }
      // Recorded before discovery/recovery tools and text paging were added, with this same catalog fixture.
      const previousStandardSmall = 22_371
      const previousStandardLarge = 30_591
      const taskSmall = standardSmall.tools.find((tool) => tool.id === "task")
      const taskLean = leanLarge.tools.find((tool) => tool.id === "task")
      if (!taskSmall || !taskLean) throw new Error("Task tool definition is missing")
      const taskSchemaSmall = JSON.stringify(ToolJsonSchema.fromTool(taskSmall))
      const taskSchemaLean = JSON.stringify(ToolJsonSchema.fromTool(taskLean))

      expect(standardSmall.bytes).toBeLessThan(standardLarge.bytes)
      expect(leanSmall.bytes).toBe(leanLarge.bytes)
      expect(leanLarge.bytes).toBeLessThan(standardLarge.bytes)
      expect(leanSmall.bytes).toBeGreaterThan(previousStandardSmall)
      expect(leanLarge.bytes).toBeLessThan(previousStandardLarge)
      expect(addedDefinitionOverhead(leanSmall)).toBe(addedDefinitionOverhead(leanLarge))
      expect(leanLarge.serialized.task.description).toContain("agent_search")
      expect(leanLarge.serialized.task.description).not.toContain("worker-120")
      expect(standardLarge.serialized.task.description).toContain("worker-120")
      expect(taskSchemaLean).toBe(taskSchemaSmall)
      expect(taskSchemaLean).toContain("subagent_type")
      expect(taskSchemaLean).toContain("prompt")
      expect(definitionHooks.has("agent_search")).toBe(true)
      expect(definitionHooks.has("tool_result")).toBe(true)

      console.log(
        JSON.stringify({
          fixtureAgents: { small: 3, large: 120 },
          providerDefinitionBytes: {
            standardSmall: standardSmall.bytes,
            leanSmall: leanSmall.bytes,
            standardLarge: standardLarge.bytes,
            leanLarge: leanLarge.bytes,
            previousStandardSmall,
            previousStandardLarge,
          },
          addedDefinitionOverheadBytes: addedDefinitionOverhead(leanSmall),
          readDefinitionGrowthBytes: leanSmall.bytes - 23_587,
        }),
      )
    }),
  )
})
