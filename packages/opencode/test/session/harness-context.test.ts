import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { jsonSchema, tool as aiTool, type ModelMessage } from "ai"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { HarnessPolicy } from "@opencode-ai/core/harness/policy"
import { ContextTrace } from "@opencode-ai/core/harness/trace"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Auth } from "../../src/auth"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { LLMRequestPrep } from "../../src/session/llm/request"
import { CODE_MODE_TOOL, CodeModeTool, describeCatalog } from "../../src/tool/code-mode"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { Tool } from "../../src/tool/tool"
import { Truncate } from "../../src/tool/truncate"
import { MessageID, SessionID } from "../../src/session/schema"
import { Session } from "../../src/session/session"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "effect",
    description: "Build applications with Effect",
    location: "/tmp/effect/SKILL.md",
    content: "Effect body",
  },
]
const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const systemLayer = (
  contextMode: HarnessPolicy.Interface["contextMode"],
  codeMode: boolean,
  availableSkills: Skill.Info[] = skills,
) =>
  LayerNode.compile(SystemPrompt.node, [
    [
      HarnessPolicy.node,
      Layer.succeed(HarnessPolicy.Service, HarnessPolicy.Service.of({ contextMode, auditMode: "off" })),
    ],
    [RuntimeFlags.node, RuntimeFlags.layer({ experimentalCodeMode: codeMode })],
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () => Effect.die("SystemPrompt must not query MCP instructions"),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: () => Effect.succeed(undefined),
          require: () => Effect.die("unused"),
          all: () => Effect.succeed(availableSkills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(availableSkills),
        }),
      ),
    ],
  ])

const requestSessionID = SessionID.make("ses_harness_request_test")
const requestModel: Provider.Model = {
  id: ModelV2.ID.make("test-model"),
  providerID: ProviderV2.ID.make("openai"),
  api: { id: "test-model", url: "https://example.test/v1", npm: "@ai-sdk/openai" },
  name: "Harness Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 100_000, output: 4_000 },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}
const requestProvider: Provider.Info = {
  id: ProviderV2.ID.make("openai"),
  name: "OpenAI",
  source: "config",
  env: [],
  options: {},
  models: { [requestModel.id]: requestModel },
}
const requestAgent: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}
const requestUser: SessionV1.User = {
  id: MessageID.make("msg_harness_request_test"),
  sessionID: requestSessionID,
  role: "user",
  time: { created: 0 },
  agent: requestAgent.name,
  model: { providerID: requestModel.providerID, modelID: requestModel.id },
}
const requestPlugin = (transform?: (name: string, output: unknown) => void): Plugin.Interface => ({
  trigger: (name, _input, output, observer) =>
    Effect.sync(() => {
      const finish = observer?.({ kind: "runtime", id: "request-test-plugin", ordinal: 0 }, output)
      transform?.(name, output)
      finish?.("success")
      return output
    }),
  list: () => Effect.succeed([]),
  init: () => Effect.void,
})
const requestInput = (
  flags: RuntimeFlags.Info,
  overrides: Partial<Parameters<typeof LLMRequestPrep.prepare>[0]> = {},
) =>
  ({
    user: requestUser,
    sessionID: requestSessionID,
    model: requestModel,
    agent: requestAgent,
    system: [],
    messages: [{ role: "user", content: "Hello" }] satisfies ModelMessage[],
    tools: {},
    provider: requestProvider,
    auth: undefined,
    plugin: requestPlugin(),
    flags,
    isWorkflow: false,
    ...overrides,
  }) satisfies Parameters<typeof LLMRequestPrep.prepare>[0]

const prep = testEffect(RuntimeFlags.layer())
const general = testEffect(RuntimeFlags.layer())

const standard = testEffect(systemLayer("standard", false))
const lean = testEffect(systemLayer("lean", true))

describe("HarnessContext V1 system prompt", () => {
  standard.effect("keeps the skill catalog and leaves MCP guidance out of the system prompt", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      expect(yield* prompt.skills(build)).toContain("- effect: Build applications with Effect")
      expect(yield* prompt.mcp(build)).toBeUndefined()
    }),
  )

  lean.effect("omits the skill catalog and MCP guidance in lean code mode", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      expect(yield* prompt.skills(build)).toBeUndefined()
      expect(yield* prompt.mcp(build)).toBeUndefined()

      const executeDenied = {
        ...build,
        permission: Permission.fromConfig({ "*": "allow", execute: "deny" }),
      }
      const deniedGuidance = yield* prompt.mcp(executeDenied)
      expect(deniedGuidance).toBeUndefined()
    }),
  )
})

describe("LLMRequestPrep harness context", () => {
  prep.effect("preserves explicit user tool selections while legacy rule records remain inert", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const editor = () => aiTool({ description: "Editor fixture", inputSchema: jsonSchema({ type: "object" }) })
      const result = yield* LLMRequestPrep.prepare(
        requestInput(flags, {
          contextMode: "lean",
          agent: { ...requestAgent, permission: [{ permission: "*", pattern: "*", action: "deny" }] },
          permission: [{ permission: "edit", pattern: "*", action: "ask" }],
          user: { ...requestUser, tools: { write: false, edit: true } },
          tools: { write: editor(), edit: editor(), apply_patch: editor() },
        }),
      )
      expect(Object.keys(result.tools)).toEqual(["apply_patch", "edit"])
    }),
  )

  prep.effect("uses the neutral lean base and preserves agent, project, and session instructions", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const lean = yield* LLMRequestPrep.prepare(
        requestInput(flags, { contextMode: "lean", system: ["Project instructions"] }),
      )
      expect(lean.system).toEqual([[HarnessPolicy.BASE, "Project instructions"].join("\n")])

      const custom = yield* LLMRequestPrep.prepare(
        requestInput(flags, {
          contextMode: "lean",
          agent: { ...requestAgent, prompt: "Custom agent prompt" },
          system: ["Project instructions"],
          user: { ...requestUser, system: "Session instructions" },
        }),
      )
      expect(custom.system).toEqual([
        ["Custom agent prompt", "Project instructions", "Session instructions"].join("\n"),
      ])
      expect(custom.system[0]).not.toContain(HarnessPolicy.BASE)
    }),
  )

  prep.effect("includes injected system-transform text in the final prepared messages", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const result = yield* LLMRequestPrep.prepare(
        requestInput(flags, {
          contextMode: "lean",
          plugin: requestPlugin((name, output) => {
            if (name !== "experimental.chat.system.transform") return
            ;(output as { system: string[] }).system.push("Plugin injected system text")
          }),
        }),
      )
      expect(result.system).toContain("Plugin injected system text")
      expect(result.messages).toContainEqual({ role: "system", content: "Plugin injected system text" })
    }),
  )

  prep.effect("exposes chat.params instruction changes through the OpenAI OAuth path", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const result = yield* LLMRequestPrep.prepare(
        requestInput(flags, {
          contextMode: "lean",
          system: ["Project instructions"],
          user: { ...requestUser, system: "Session instructions" },
          auth: new Auth.Oauth({
            type: "oauth",
            access: "test-access",
            refresh: "test-refresh",
            expires: 0,
          }),
          plugin: requestPlugin((name, output) => {
            if (name !== "chat.params") return
            const options = (output as { options: Record<string, unknown> }).options
            options.instructions = `${String(options.instructions)}\nOAuth plugin instruction`
          }),
        }),
      )
      expect(result.params.options.instructions).toContain("OAuth plugin instruction")
      expect(result.params.options.instructions).toContain("Project instructions")
      expect(result.params.options.instructions).toContain("Session instructions")
    }),
  )

  prep.effect("traces consumed system text and OAuth instruction rewrites without retaining content", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const trace = ContextTrace.create()
      const result = yield* LLMRequestPrep.prepare(
        requestInput(flags, {
          contextMode: "lean",
          contextTrace: trace,
          auth: new Auth.Oauth({ type: "oauth", access: "not-for-audit", refresh: "not-for-audit", expires: 0 }),
          plugin: requestPlugin((name, output) => {
            if (name === "experimental.chat.system.transform") {
              ;(output as { system: string[] }).system.push("System hook text")
            }
            if (name === "chat.params") {
              ;(output as { options: Record<string, unknown> }).options = {
                instructions: "Effective OAuth instructions",
              }
            }
          }),
        }),
      )
      expect(result.params.options.instructions).toBe("Effective OAuth instructions")
      expect(result.system).toContain("System hook text")
      const capture = trace.capture()
      expect(capture.records.map((item) => [item.stage, item.projection, item.change])).toEqual([
        ["experimental.chat.system.transform", "consumed-system-array", "changed"],
        ["chat.params", "options.instructions", "changed"],
      ])
      expect(JSON.stringify(capture)).not.toContain("Effective OAuth instructions")
      expect(JSON.stringify(capture)).not.toContain("not-for-audit")
    }),
  )

  prep.effect("keeps tracing and preparation aligned when a system wrapper replacement is ignored", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const trace = ContextTrace.create()
      const result = yield* LLMRequestPrep.prepare(
        requestInput(flags, {
          contextMode: "lean",
          contextTrace: trace,
          plugin: requestPlugin((name, output) => {
            if (name === "experimental.chat.system.transform") {
              ;(output as { system: string[] }).system = ["Ignored replacement"]
            }
          }),
        }),
      )
      expect(result.system).toEqual([HarnessPolicy.BASE])
      expect(result.messages).toContainEqual({ role: "system", content: HarnessPolicy.BASE })
      expect(trace.capture().records[0].change).toBe("unchanged")
    }),
  )

  prep.effect("does not invoke instruction accessors while observing plugin options", () =>
    Effect.gen(function* () {
      const flags = yield* RuntimeFlags.Service
      const trace = ContextTrace.create()
      let reads = 0
      yield* LLMRequestPrep.prepare(
        requestInput(flags, {
          contextMode: "lean",
          contextTrace: trace,
          plugin: requestPlugin((name, output) => {
            if (name !== "chat.params") return
            ;(output as { options: Record<string, unknown> }).options = Object.defineProperty({}, "instructions", {
              enumerable: true,
              get() {
                reads += 1
                return "accessor text"
              },
            })
          }),
        }),
      )
      expect(reads).toBe(0)
      const record = trace.capture().records.find((item) => item.stage === "chat.params")
      expect(record?.after).toEqual({ status: "incomplete", reason: "unsupported" })
      expect(record?.change).toBe("unknown")
    }),
  )
})

describe("HarnessContext byte accounting", () => {
  general.effect(
    "measures standard versus lean prepared context with the same real skill and CodeMode definitions",
    () =>
      Effect.gen(function* () {
        const flags = yield* RuntimeFlags.Service
        const fixtureSkills = Array.from({ length: 15 }, (_, index) => ({
          name: `skill-${index + 1}`,
          description: `Use this skill for focused implementation and validation in domain ${index + 1}, with repository-specific guidance and safe tool use.`,
          location: `/tmp/skill-${index + 1}/SKILL.md`,
          content: `Skill ${index + 1} instructions`,
        })) satisfies Skill.Info[]

        const standardSystem = yield* Effect.gen(function* () {
          const prompt = yield* SystemPrompt.Service
          const skills = yield* prompt.skills(build)
          const mcp = yield* prompt.mcp(build)
          if (skills === undefined || mcp !== undefined)
            return yield* Effect.die("standard prompt unexpectedly omitted context")
          return [skills]
        }).pipe(Effect.provide(systemLayer("standard", true, fixtureSkills)))

        const leanSystem = yield* Effect.gen(function* () {
          const prompt = yield* SystemPrompt.Service
          const skills = yield* prompt.skills(build)
          const mcp = yield* prompt.mcp(build)
          if (mcp !== undefined) return yield* Effect.die("lean prompt unexpectedly included MCP guidance")
          return [...(skills ? [skills] : []), ...(mcp ? [mcp] : [])]
        }).pipe(Effect.provide(systemLayer("lean", true, fixtureSkills)))

        const codeModeTools = {
          "guide-server_lookup": {
            def: {
              name: "lookup",
              description: "Search reference records by query.",
              inputSchema: { type: "object", properties: { query: { type: "string" } } },
            } satisfies MCP.McpTool["def"],
            client: {} as MCP.McpTool["client"],
          },
        } satisfies Record<string, MCP.McpTool>
        const codeTool = yield* CodeModeTool.pipe(
          Effect.flatMap(Tool.init),
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(Plugin.Service, {}),
              Layer.mock(Agent.Service, {}),
              Layer.mock(MCP.Service, {}),
              Layer.mock(Session.Service, {}),
              Layer.mock(Truncate.Service, {}),
            ),
          ),
        )
        const executeDescription = [codeTool.description, describeCatalog(codeModeTools, ["guide-server"])].join("\n")
        const toolSchemas = {
          skill: jsonSchema(Schema.toJsonSchemaDocument(SkillTool.Input).schema),
          [CODE_MODE_TOOL]: jsonSchema(Schema.toJsonSchemaDocument(codeTool.parameters).schema),
        }
        const tools = {
          skill: aiTool({ description: SkillTool.description, inputSchema: toolSchemas.skill }),
          [CODE_MODE_TOOL]: aiTool({ description: executeDescription, inputSchema: toolSchemas[CODE_MODE_TOOL] }),
        }

        const standard = yield* LLMRequestPrep.prepare(
          requestInput(flags, { contextMode: "standard", system: standardSystem, tools }),
        )
        const lean = yield* LLMRequestPrep.prepare(
          requestInput(flags, { contextMode: "lean", system: leanSystem, tools }),
        )
        const toolDefinitionBytes = Buffer.byteLength(
          JSON.stringify({
            skill: { description: SkillTool.description, schema: Schema.toJsonSchemaDocument(SkillTool.Input).schema },
            [CODE_MODE_TOOL]: {
              description: executeDescription,
              schema: Schema.toJsonSchemaDocument(codeTool.parameters).schema,
            },
          }),
        )
        const standardBytes = Buffer.byteLength(standard.system.join("\n")) + toolDefinitionBytes
        const leanBytes = Buffer.byteLength(lean.system.join("\n")) + toolDefinitionBytes

        expect(standard.system.join("\n")).toContain("skill-15")
        expect(standard.system.join("\n")).not.toContain("MCP_DEMAND_GUIDANCE")
        expect(standard.system.join("\n")).not.toContain("MCP servers with guidance")
        expect(lean.system.join("\n")).not.toContain("skill-15")
        expect(lean.system.join("\n")).not.toContain("MCP servers with guidance")
        expect(executeDescription).not.toContain("Use lookup before mutating data.")
        expect(standardBytes - leanBytes).toBeGreaterThan(0)
        expect(standard.tools.skill?.description).toBe(SkillTool.description)
        expect(standard.tools.execute?.description).toBe(executeDescription)
        expect(lean.tools.skill?.description).toBe(SkillTool.description)
        expect(lean.tools.execute?.description).toBe(executeDescription)
        expect(lean.tools.skill?.description).toContain("query to search names and descriptions")
        expect(lean.tools.skill?.description).toContain("Search does not load skill bodies")
        expect(lean.tools.execute?.description).toContain("$mcp.instructions")
        expect(lean.tools.execute?.description).toContain("$mcp.servers")
        expect(lean.tools.execute?.description).toContain("connect or disconnect")
        expect(lean.tools.execute?.description).toContain("Newly connected tools appear in the next execute call")
        expect(lean.tools.execute?.description).toContain("cached server guidance")
        expect(lean.messages.some((message) => message.role === "system" && message.content.includes("skill-15"))).toBe(
          false,
        )
      }),
  )
})
