import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Cause, Effect, Exit, Layer } from "effect"
import { afterEach, describe, expect } from "bun:test"
import path from "path"
import { Permission } from "../../src/permission"
import { Session } from "../../src/session/session"
import type { Tool } from "@/tool/tool"
import { SkillTool } from "../../src/tool/skill"
import { ToolRegistry } from "@/tool/registry"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { SessionID, MessageID } from "../../src/session/schema"
import { testEffect } from "../lib/effect"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
}

afterEach(async () => {
  await disposeAllInstances()
})

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([ToolRegistry.node, CrossSpawnSpawner.node, Ripgrep.node, Session.node, SessionProjector.node]),
  ),
)

describe("tool.skill", () => {
  it.instance("execute returns skill content block with files", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const skill = path.join(dir, ".opencode", "skill", "tool-skill")
      yield* Effect.promise(() =>
        Bun.write(
          path.join(skill, "SKILL.md"),
          `---
name: tool-skill
description: Skill for tool tests.
---

# Tool Skill

Use this skill.
`,
        ),
      )
      yield* Effect.promise(() => Bun.write(path.join(skill, "scripts", "demo.txt"), "demo"))
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, ".opencode", "skill", "hidden-skill", "SKILL.md"),
          "---\nname: hidden-skill\ndescription: Hidden tool tests.\n---\nHidden body",
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, ".opencode", "skill", "session-skill", "SKILL.md"),
          "---\nname: session-skill\ndescription: Session tool tests.\n---\nSession private body",
        ),
      )
      yield* Effect.promise(() =>
        Bun.write(
          path.join(dir, ".opencode", "opencode.json"),
          JSON.stringify({ permission: { skill: { "hidden-skill": "deny" } } }),
        ),
      )

      const home = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = dir
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.OPENCODE_TEST_HOME = home
        }),
      )

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      expect(tool.description).not.toContain("tool-skill")
      expect(tool.description).not.toContain("Skill for tool tests.")

      const requests: Array<Omit<PermissionV1.Request, "id" | "sessionID" | "tool">> = []
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        permission: Permission.fromConfig({ skill: { "session-skill": "deny" } }),
      })
      const ctx: Tool.Context = {
        ...baseCtx,
        sessionID: session.id,
        ask: (req) =>
          Effect.sync(() => {
            requests.push(req)
          }),
      }

      const discovery = yield* tool.execute({ query: "tool tests" }, ctx)
      expect(discovery.output).toContain('"name":"tool-skill"')
      expect(discovery.output).toContain('"name":"hidden-skill"')
      expect(discovery.output).toContain('"name":"session-skill"')
      expect(discovery.output).toContain("Hidden tool tests.")
      expect(discovery.output).toContain("Session tool tests.")
      expect(discovery.output).not.toContain("Use this skill.")
      expect(discovery.output).not.toContain("SKILL.md")
      expect(discovery.metadata.contextSource).toBeUndefined()
      expect(ToolSource.inspect(discovery.output, discovery.metadata).state).toBe("missing")
      expect(requests).toHaveLength(0)

      for (const input of [
        {},
        { name: "tool-skill", query: "tool tests" },
        { name: "tool-skill", offset: 1 },
        { name: "tool-skill", limit: 1 },
      ]) {
        const exit = yield* tool.execute(input, ctx).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause)
          expect(error).toBeInstanceOf(Error)
          if (error instanceof Error) {
            expect(error.message).toBe(
              input.name === undefined
                ? "Provide a skill name or metadata query."
                : "Use name to load, or query with pagination to search, not both.",
            )
          }
        }
      }
      expect(requests).toHaveLength(0)

      const result = yield* tool.execute({ name: "tool-skill" }, ctx)
      const file = path.resolve(skill, "scripts", "demo.txt")

      expect(requests.length).toBe(1)
      expect(requests[0].permission).toBe("skill")
      expect(requests[0].patterns).toContain("tool-skill")
      expect(requests[0].always).toContain("tool-skill")
      expect(result.metadata.dir).toBe(skill)
      expect(result.output).toContain(`<skill_content name="tool-skill">`)
      expect(result.output).toContain(`Base directory for this skill: ${skill}`)
      expect(result.output).toContain(`<file>${file}</file>`)
      expect(result.output).toBe(
        [
          '<skill_content name="tool-skill">',
          "# Skill: tool-skill",
          "",
          "# Tool Skill",
          "",
          "Use this skill.",
          "",
          `Base directory for this skill: ${skill}`,
          "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
          "Note: file list is sampled.",
          "",
          "<skill_files>",
          `<file>${file}</file>`,
          "</skill_files>",
          "</skill_content>",
        ].join("\n"),
      )
      const source = ToolSource.inspect(result.output, result.metadata)
      expect(source).toMatchObject({ state: "matched", kind: "skill", origin: path.join(skill, "SKILL.md") })
      if (source.state === "matched" && source.body.type === "utf16-span") {
        expect(result.output.slice(source.body.start, source.body.end)).toBe("# Tool Skill\n\nUse this skill.")
        expect(source.body.bytes).toBe(Buffer.byteLength("# Tool Skill\n\nUse this skill.", "utf8"))
      } else {
        throw new Error("Expected skill content source span")
      }
    }),
  )

  it.instance("execute preserves not found message", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const home = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = dir
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          process.env.OPENCODE_TEST_HOME = home
        }),
      )

      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      const tool = (yield* registry.tools({
        providerID: "opencode" as any,
        modelID: "gpt-5" as any,
        agent,
      })).find((tool) => tool.id === SkillTool.id)
      if (!tool) throw new Error("Skill tool not found")

      const exit = yield* tool
        .execute(
          { name: "missing-skill" },
          {
            ...baseCtx,
            ask: () => Effect.void,
          },
        )
        .pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(Error)
        if (error instanceof Error) {
          expect(error.message).toBe('Skill "missing-skill" not found. Search metadata with query.')
          expect(error.message).not.toContain("Available skills:")
        }
      }
    }),
  )
})
