import { ProjectStore } from "@opencode-ai/core/project/store"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) =>
  Effect.gen(function* () {
    const projects = yield* ProjectStore.Service
    return handlers.handle("project.list", () => projects.list())
  }),
)
