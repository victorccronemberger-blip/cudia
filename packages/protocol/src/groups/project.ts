import { Project } from "@opencode-ai/schema/project"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const ProjectGroup = HttpApiGroup.make("server.project").add(
  HttpApiEndpoint.get("project.list", "/api/project", {
    success: Schema.Array(Project.Info),
  }).annotateMerge(
    OpenApi.annotations({
      identifier: "v2.project.list",
      summary: "List projects",
      description: "Retrieve persisted project metadata without initializing a filesystem location.",
    }),
  ),
)
