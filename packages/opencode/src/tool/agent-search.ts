import { Effect, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "@opencode-ai/core/schema"
import { SkillCatalog } from "@opencode-ai/core/skill/catalog"
import { Agent } from "../agent/agent"
import { Session } from "../session/session"
import { Permission } from "../permission"
import { Tool } from "./tool"
import DESCRIPTION from "./agent-search.txt"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({ description: "Search agent names and descriptions; empty string browses" }),
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(SkillCatalog.MAX_PAGE_SIZE))),
})

type Metadata = { matches?: string[]; total?: number }

export const AgentSearchTool = Tool.define(
  "agent_search",
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const caller = yield* agents.get(ctx.agent)
          if (!caller) return yield* Effect.die(new Error(`Unknown agent: ${ctx.agent}`))
          const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
          const ruleset = Permission.merge(caller.permission, session.permission ?? [])
          const visible = (yield* agents.list()).filter(
            (item) =>
              item.mode !== "primary" &&
              !item.hidden &&
              Permission.evaluate("task", item.name, ruleset).action !== "deny",
          )
          const result = SkillCatalog.search(visible, {
            query: params.query,
            offset: params.offset,
            limit: params.limit,
          })
          return {
            title: "Agent metadata",
            output: JSON.stringify(result),
            metadata: { matches: result.matches.map((item) => item.name), total: result.total },
          }
        }),
    }
  }),
)
