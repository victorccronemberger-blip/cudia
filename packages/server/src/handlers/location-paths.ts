import { Global } from "@opencode-ai/core/global"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const LocationPathsHandler = HttpApiBuilder.group(Api, "server.locationPaths", (handlers) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    return handlers.handle("locationPaths.get", () =>
      Effect.sync(() => ({ home: AbsolutePath.make(global.home), defaultDirectory: AbsolutePath.make(process.cwd()) })),
    )
  }),
)
