import { describe, expect } from "bun:test"
import path from "path"
import { Effect } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { ProjectStore } from "../src/project/store"
import { ProjectTable } from "../src/project/sql"
import { Database } from "../src/database/database"
import { AbsolutePath } from "../src/schema"
import { ProjectSchema } from "../src/project/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, ProjectStore.node])))

function row(input: { readonly id: ProjectSchema.ID; readonly worktree: AbsolutePath; readonly vcs?: string }) {
  return {
    id: input.id,
    worktree: input.worktree,
    vcs: input.vcs ?? null,
    name: "Store test",
    icon_url: "https://example.test/icon.png",
    icon_url_override: "data:image/png;base64,abc",
    icon_color: "#123456",
    time_created: 10,
    time_updated: 20,
    time_initialized: 30,
    sandboxes: [AbsolutePath.make(path.resolve("project-store-sandbox"))],
    commands: { start: "bun run start" },
  }
}

function insert(value: ReturnType<typeof row>) {
  return Database.Service.use(({ db }) => db.insert(ProjectTable).values(value).run().pipe(Effect.orDie))
}

describe("ProjectStore", () => {
  it.effect("gets the complete project shape from a row", () =>
    Effect.gen(function* () {
      const input = row({
        id: ProjectSchema.ID.make(`project-store-${crypto.randomUUID()}`),
        worktree: AbsolutePath.make(path.resolve("project-store-worktree")),
        vcs: "git",
      })
      yield* insert(input)

      const projects = yield* ProjectStore.Service
      expect(yield* projects.get(input.id)).toEqual({
        id: input.id,
        worktree: input.worktree,
        vcs: "git",
        name: "Store test",
        icon: {
          url: "https://example.test/icon.png",
          override: "data:image/png;base64,abc",
          color: "#123456",
        },
        time: { created: 10, updated: 20, initialized: 30 },
        sandboxes: input.sandboxes,
        commands: { start: "bun run start" },
      })
    }),
  )

  it.effect("lists projects and preserves empty optional metadata", () =>
    Effect.gen(function* () {
      const input = {
        ...row({
          id: ProjectSchema.ID.make(`project-store-${crypto.randomUUID()}`),
          worktree: AbsolutePath.make(path.resolve("project-store-non-git")),
        }),
        name: null,
        icon_url: null,
        icon_url_override: null,
        icon_color: null,
        time_initialized: null,
        commands: null,
      }
      yield* Database.Service.use(({ db }) => db.insert(ProjectTable).values(input).run().pipe(Effect.orDie))

      const projects = yield* ProjectStore.Service
      const listed = yield* projects.list()
      expect(listed).toContainEqual({
        id: input.id,
        worktree: input.worktree,
        vcs: undefined,
        name: undefined,
        icon: undefined,
        time: { created: 10, updated: 20, initialized: undefined },
        sandboxes: input.sandboxes,
        commands: undefined,
      })
    }),
  )

  it.effect("returns undefined when the project id is absent", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.Service
      expect(yield* projects.get(ProjectSchema.ID.make(`project-store-missing-${crypto.randomUUID()}`))).toBeUndefined()
    }),
  )
})
