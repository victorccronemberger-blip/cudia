export * as SkillGuidance from "./guidance"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SkillV2 } from "../skill"
import { SkillCatalog } from "./catalog"
import { SystemContext } from "../system-context/index"
import { HarnessPolicy } from "../harness/policy"
import { ContextManifest } from "../harness/context-manifest"

const Summary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})
type Summary = typeof Summary.Type

export interface Interface {
  readonly load: (agent: AgentV2.Selection) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SkillGuidance") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* SkillV2.Service
    const policy = yield* HarnessPolicy.Service

    return Service.of({
      load: Effect.fn("SkillGuidance.load")(function* (selection) {
        if (policy.contextMode === "lean") return SystemContext.empty
        const agent = selection.info
        if (!agent) return SystemContext.empty
        const permitted = SkillV2.available(yield* skills.list(), agent)
        if (permitted.length === 0 && PermissionV2.evaluate("skill", "*", agent.permissions).effect === "deny")
          return SystemContext.empty
        const available = permitted
          .flatMap((skill) =>
            skill.description === undefined ? [] : [{ name: skill.name, description: skill.description }],
          )
          .toSorted((a, b) => a.name.localeCompare(b.name))
        return SystemContext.make({
          key: SystemContext.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          load: Effect.succeed(available),
          baseline: SkillCatalog.renderWithOrigins,
          update: (_previous, current) => {
            const prefix =
              "The available skills have changed. This list supersedes the previous available skills list.\n"
            const rendered = SkillCatalog.renderWithOrigins(current)
            return {
              text: prefix + rendered.text,
              origins: rendered.origins.map((origin) => ({
                ...origin,
                start: origin.start + prefix.length,
                end: origin.end + prefix.length,
              })),
            } satisfies ContextManifest.Rendered
          },
          removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
        })
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [SkillV2.node, HarnessPolicy.node] })
