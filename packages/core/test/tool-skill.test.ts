import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_skill_tool_test")

describe("SkillTool", () => {
  it.live("lists available skills, authorizes the selected name, and loads model-facing content", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "effect")
          const location = path.join(directory, "SKILL.md")
          const reference = path.join(directory, "reference.md")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(location, "unused"), fs.writeFile(reference, "reference")]),
          )

          const info: SkillV2.Info = {
            name: "effect",
            description: "Use Effect",
            location: AbsolutePath.make(location),
            content: "# Effect\n\nGuidance",
          }
          let current = [info, { ...info, name: "denied", description: "Use Effect secretly", content: "Secret body" }]
          const assertions: PermissionV2.AssertInput[] = []
          let deny = false
          const permission = Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              check: () => Effect.die("unused"),
              assert: (input) =>
                Effect.sync(() => assertions.push(input)).pipe(
                  Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
                ),
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
            }),
          )
          const skills = Layer.succeed(
            SkillV2.Service,
            SkillV2.Service.of({
              transform: (_transform) => Effect.die("unused"),
              reload: () => Effect.die("unused"),
              sources: () => Effect.die("unused"),
              list: () => Effect.succeed(current),
            }),
          )
          const skillToolLayer = AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SkillTool.node]),
            [
              [PermissionV2.node, permission],
              [
                AgentV2.node,
                Layer.mock(AgentV2.Service, {
                  get: () =>
                    Effect.succeed(
                      AgentV2.Info.make({
                        ...AgentV2.Info.empty(toolIdentity.agent),
                        permissions: [{ action: "skill", resource: "denied", effect: "deny" }],
                      }),
                    ),
                }),
              ],
              [SkillV2.node, skills],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ],
          )

          return yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            expect((yield* toolDefinitions(registry))[0]).toMatchObject({
              name: "skill",
              description: SkillTool.description,
            })
            const searched = yield* settleTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-skill-search", name: "skill", input: { query: "Effect" } },
            })
            expect(searched.result).toEqual({
              type: "text",
              value: JSON.stringify({
                matches: [
                  { name: "effect", description: "Use Effect" },
                  { name: "denied", description: "Use Effect secretly" },
                ],
                total: 2,
              }),
            })
            expect(searched.contextSources).toBeUndefined()
            expect(assertions).toHaveLength(0)
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: {
                  type: "tool-call",
                  id: "call-skill-ambiguous",
                  name: "skill",
                  input: { name: "effect", query: "effect" },
                },
              }),
            ).toEqual({ type: "error", value: "Use name to load, or query with pagination to search, not both." })
            const loaded = yield* settleTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-skill", name: "skill", input: { name: "effect" } },
            })
            const rendered = SkillTool.toModelOutput(info, [reference])
            expect(loaded.result).toEqual({
              type: "text",
              value: rendered,
            })
            expect(loaded.contextSources).toMatchObject({
              version: 1,
              projection: "original",
              omitted: 0,
              entries: [{ contentIndex: 0, receipt: { kind: "skill", origin: location } }],
            })
            const receipt = loaded.contextSources?.entries[0]?.receipt
            expect(receipt).toBeDefined()
            if (!receipt) throw new Error("Expected skill source receipt")
            const observation = ToolSource.inspect(rendered, { contextSource: receipt })
            expect(observation).toMatchObject({ state: "matched", kind: "skill", origin: location })
            if (observation.state !== "matched" || observation.body.type !== "utf16-span")
              throw new Error("Expected matching skill content span")
            expect(rendered.slice(observation.body.start, observation.body.end)).toBe(info.content.trim())
            expect(SkillTool.toModelOutput(info, [reference])).toContain(`Base directory for this skill: ${directory}`)
            expect(
              yield* settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill-overflow", name: "skill", input: { name: "effect" } },
              }),
            ).toMatchObject({
              result: { type: "text", value: SkillTool.toModelOutput(info, [reference]) },
              output: { structured: { name: "effect" } },
            })
            expect(assertions).toMatchObject([
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
            ])
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-missing-skill", name: "skill", input: { name: "missing" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill missing" })
            deny = true
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-denied-skill", name: "skill", input: { name: "effect" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill effect" })
            deny = false
            const flat = SkillV2.Info.make({
              name: "public",
              description: "Public guidance",
              location: AbsolutePath.make(path.join(tmp.path, "public.md")),
              content: "Public",
            })
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(flat.location, "public"),
                fs.writeFile(path.join(tmp.path, "secret.md"), "secret"),
              ]),
            )
            current = [flat]
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-flat-skill", name: "skill", input: { name: "public" } },
              }),
            ).toEqual({ type: "text", value: SkillTool.toModelOutput(flat, []) })

            const longContent = Array.from({ length: 2_100 }, (_, index) => {
              if (index === 0) return "LONG_SKILL_FIRST_LINE"
              if (index === 1_050) return "LONG_SKILL_OMITTED_MIDDLE_LINE"
              return `Long skill body line ${index}`
            }).join("\n")
            const large = SkillV2.Info.make({
              ...flat,
              name: "large",
              location: AbsolutePath.make(path.join(tmp.path, "large", "SKILL.md")),
              content: longContent,
            })
            yield* Effect.promise(() => fs.mkdir(path.dirname(large.location), { recursive: true }))
            yield* Effect.promise(() => fs.writeFile(large.location, "large skill"))
            current = [large]
            const bounded = yield* settleTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-large-skill", name: "skill", input: { name: "large" } },
            })
            expect(bounded.contextSources).toMatchObject({ version: 1, projection: "replaced" })
            expect(bounded.outputPaths).toHaveLength(1)
            expect(bounded.result.type).toBe("text")
            if (bounded.result.type !== "text") throw new Error("Expected bounded skill text")
            const boundedText = bounded.result.value
            if (typeof boundedText !== "string") throw new Error("Expected bounded skill string")
            expect(bounded.result.value).toContain("LONG_SKILL_FIRST_LINE")
            expect(bounded.result.value).not.toContain("LONG_SKILL_OMITTED_MIDDLE_LINE")
            const boundedReceipt = bounded.contextSources?.entries[0]?.receipt
            expect(boundedReceipt).toBeDefined()
            if (!boundedReceipt) throw new Error("Expected bounded skill receipt")
            expect(ToolSource.inspect(boundedText, { contextSource: boundedReceipt }).state).toBe("changed")
          }).pipe(Effect.provide(skillToolLayer))
        }),
      ),
    ),
  )
})
