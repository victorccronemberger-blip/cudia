export * as SkillTool from "./skill"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { SkillV2 } from "../skill"
import { SkillCatalog } from "../skill/catalog"
import { AgentV2 } from "../agent"
import { NonNegativeInt, PositiveInt } from "../schema"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { ToolProvenance } from "./provenance"
import { ToolSource } from "../harness/tool-source"

export const name = "skill"
const FILE_LIMIT = 10

export const Input = Schema.Struct({
  name: Schema.optional(Schema.String.annotate({ description: "Load this exact skill name" })),
  query: Schema.optional(
    Schema.String.annotate({ description: "Search names and descriptions; empty string browses" }),
  ),
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(SkillCatalog.MAX_PAGE_SIZE))),
})

export const Output = Schema.Union([
  Schema.Struct({ name: Schema.String, directory: Schema.String, output: Schema.String }),
  Schema.Struct({
    matches: Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) })),
    total: NonNegativeInt,
    nextOffset: Schema.optional(NonNegativeInt),
    omitted: Schema.optional(NonNegativeInt),
  }),
])

export const description =
  'Use name to load a skill\'s instructions and resource paths, or query to search names and descriptions with offset/limit pagination. query: "" browses. Search does not load skill bodies. Loading by name and searching are mutually exclusive; offset/limit apply to search.'

export const toModelOutput = (skill: SkillV2.Info, files: ReadonlyArray<string>) => {
  const directory = path.dirname(skill.location)
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    `Base directory for this skill: ${directory}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${file}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const skills = yield* SkillV2.Service
    const agents = yield* AgentV2.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [
            { type: "text", text: "output" in output ? output.output : JSON.stringify(output) },
          ],
          execute: (input, context) =>
            Effect.gen(function* () {
              const current = yield* skills.list()
              if (input.name === undefined) {
                if (input.query === undefined)
                  return yield* new ToolFailure({ message: "Provide a skill name or metadata query." })
                const agent = yield* agents.get(context.agent)
                return SkillCatalog.search(agent ? SkillV2.available(current, agent) : [], {
                  query: input.query,
                  offset: input.offset,
                  limit: input.limit,
                })
              }
              if (input.query !== undefined || input.offset !== undefined || input.limit !== undefined)
                return yield* new ToolFailure({
                  message: "Use name to load, or query with pagination to search, not both.",
                })
              const selected = input.name
              const skill = current.find((skill) => skill.name === input.name)
              if (!skill) return yield* unableToLoad(selected)
              return yield* Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [skill.name],
                  save: [skill.name],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const directory = path.dirname(skill.location)
                const files =
                  path.basename(skill.location) === "SKILL.md"
                    ? (yield* fs.glob("**/*", { cwd: directory, absolute: true, include: "file", dot: true }))
                        .filter((file) => path.basename(file) !== "SKILL.md")
                        .toSorted()
                        .slice(0, FILE_LIMIT)
                    : []
                const output = toModelOutput(skill, files)
                const content = skill.content.trim()
                const prefix = [`<skill_content name="${skill.name}">`, `# Skill: ${skill.name}`, ""].join("\n") + "\n"
                const result = {
                  name: skill.name,
                  directory,
                  output,
                }
                return ToolProvenance.attach(result, [
                  {
                    contentIndex: 0,
                    receipt: ToolSource.create({
                      kind: "skill",
                      origin: skill.location,
                      output,
                      start: prefix.length,
                      end: prefix.length + content.length,
                    }),
                  },
                ])
              }).pipe(Effect.mapError((error) => unableToLoad(selected, error)))
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/skill",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, SkillV2.node, PermissionV2.node, AgentV2.node],
})
