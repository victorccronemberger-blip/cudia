export * as ProjectStore from "./store"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Project } from "@opencode-ai/schema/project"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { ProjectTable } from "./sql"
import { ProjectSchema } from "./schema"

type Row = typeof ProjectTable.$inferSelect
export type Info = Types.DeepMutable<Schema.Schema.Type<typeof Project.Info>>

export function fromRow(row: Row): Info {
  const icon =
    row.icon_url || row.icon_url_override || row.icon_color
      ? {
          url: row.icon_url ?? undefined,
          override: row.icon_url_override ?? undefined,
          color: row.icon_color ?? undefined,
        }
      : undefined
  return {
    id: row.id,
    worktree: row.worktree,
    vcs: row.vcs ? Schema.decodeUnknownSync(Project.Vcs)(row.vcs) : undefined,
    name: row.name ?? undefined,
    icon,
    time: {
      created: row.time_created,
      updated: row.time_updated,
      initialized: row.time_initialized ?? undefined,
    },
    sandboxes: row.sandboxes,
    commands: row.commands ?? undefined,
  }
}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: ProjectSchema.ID) => Effect.Effect<Info | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProjectStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return Service.of({
      list: Effect.fn("ProjectStore.list")(function* () {
        return (yield* db.select().from(ProjectTable).all().pipe(Effect.orDie)).map(fromRow)
      }),
      get: Effect.fn("ProjectStore.get")(function* (id: ProjectSchema.ID) {
        const row = yield* db.select().from(ProjectTable).where(eq(ProjectTable.id, id)).get().pipe(Effect.orDie)
        return row ? fromRow(row) : undefined
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
