import path from "path"
import { Effect, Schema } from "effect"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import { SkillCatalog } from "@opencode-ai/core/skill/catalog"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"
import { Agent } from "../agent/agent"
import { Session } from "../session/session"
import { Permission } from "../permission"
import { Skill } from "../skill"
import * as Tool from "./tool"
import DESCRIPTION from "./skill.txt"

export const Parameters = Schema.Struct({
  name: Schema.optional(Schema.String.annotate({ description: "Load this exact skill name" })),
  query: Schema.optional(
    Schema.String.annotate({ description: "Search names and descriptions; empty string browses" }),
  ),
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(SkillCatalog.MAX_PAGE_SIZE))),
})

type Metadata = { name?: string; dir?: string; matches?: string[]; total?: number; contextSource?: ToolSource.Receipt }

export const SkillTool = Tool.define(
  "skill",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const ripgrep = yield* Ripgrep.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (
        params: Schema.Schema.Type<typeof Parameters>,
        ctx: Tool.Context,
      ): Effect.Effect<Tool.ExecuteResult<Metadata>> =>
        Effect.gen(function* () {
          if (params.name === undefined) {
            if (params.query === undefined)
              return yield* Effect.die(new Error("Provide a skill name or metadata query."))
            const agent = yield* agents.get(ctx.agent)
            if (!agent) return yield* Effect.die(new Error(`Unknown agent: ${ctx.agent}`))
            const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
            const result = SkillCatalog.search(
              yield* skill.available({
                ...agent,
                permission: Permission.merge(agent.permission, session.permission ?? []),
              }),
              {
                query: params.query,
                offset: params.offset,
                limit: params.limit,
              },
            )
            return {
              title: "Skill metadata",
              output: JSON.stringify(result),
              metadata: { matches: result.matches.map((skill) => skill.name), total: result.total },
            }
          }
          if (params.query !== undefined || params.offset !== undefined || params.limit !== undefined)
            return yield* Effect.die(new Error("Use name to load, or query with pagination to search, not both."))
          const info = yield* skill
            .require(params.name)
            .pipe(
              Effect.catchTag("Skill.NotFoundError", () =>
                Effect.die(new Error(`Skill "${params.name?.slice(0, 160)}" not found. Search metadata with query.`)),
              ),
            )

          yield* ctx.ask({
            permission: "skill",
            patterns: [params.name],
            always: [params.name],
            metadata: {},
          })

          const dir = path.dirname(info.location)
          const base = dir
          const files = yield* ripgrep.find({
            cwd: dir,
            pattern: "!**/SKILL.md",
            hidden: true,
            follow: false,
            signal: ctx.abort,
            limit: 10,
          })

          const content = info.content.trim()
          const prefix = [`<skill_content name="${info.name}">`, `# Skill: ${info.name}`, ""].join("\n") + "\n"
          const suffix = [
            "",
            `Base directory for this skill: ${base}`,
            "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
            "Note: file list is sampled.",
            "",
            "<skill_files>",
            files.map((file) => `<file>${path.resolve(dir, file.path)}</file>`).join("\n"),
            "</skill_files>",
            "</skill_content>",
          ].join("\n")
          const output = `${prefix}${content}\n${suffix}`
          const contextSource = ToolSource.create({
            kind: "skill",
            origin: info.location,
            output,
            start: prefix.length,
            end: prefix.length + content.length,
          })
          return {
            title: `Loaded skill: ${info.name}`,
            output,
            metadata: {
              name: info.name,
              dir,
              ...(contextSource && { contextSource }),
            },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
