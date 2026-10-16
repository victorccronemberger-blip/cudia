import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { HarnessPolicy } from "@opencode-ai/core/harness/policy"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const systemLayer = (codeMode = false) =>
  LayerNode.compile(SystemPrompt.node, [
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
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          available: () => Effect.succeed(skills),
        }),
      ),
    ],
  ])

const it = testEffect(systemLayer())
const withCodeMode = testEffect(systemLayer(true))

describe("session.system", () => {
  test("uses the same neutral provider prompt across model families", () => {
    const models = [
      ...["meta/muse-spark-preview", "muse-spark-1.1", "muse-spark-1.2"].map((id) => ({ api: { id } })),
      ...["meta/muse-glimmer", "meta/muse-glimmer-30b", "muse-glimmer-30b"].map((id) => ({ api: { id } })),
      ...["kimi-for-coding", "moonshotai", "moonshotai-cn"].map((providerID) => ({ providerID, api: { id: "k3" } })),
    ]
    for (const model of models) expect(SystemPrompt.provider(model as Provider.Model)).toEqual([HarnessPolicy.BASE])
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("- alpha-skill: Alpha skill.")
      const middle = output.indexOf("- middle-skill: Middle skill.")
      const zeta = output.indexOf("- zeta-skill: Zeta skill.")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
      expect(output).not.toContain("/tmp/")
      expect(output).not.toContain("# alpha-skill")
    }),
  )

  it.effect("MCP instructions are omitted from the system prompt", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)
      expect(output).toBeUndefined()
    }),
  )

  it.effect("MCP instruction lookup stays out of the system prompt with legacy deny records", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))
      expect(output).toBeUndefined()
    }),
  )

  withCodeMode.effect("MCP instructions remain an explicit tool result in code mode", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      expect(yield* prompt.mcp(build)).toBeUndefined()
      expect(yield* prompt.mcp(build, Permission.fromConfig({ execute: "deny" }))).toBeUndefined()
    }),
  )
})
