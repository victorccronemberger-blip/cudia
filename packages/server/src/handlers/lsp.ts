import { LSPV2 } from "@opencode-ai/core/lsp"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const LSPHandler = HttpApiBuilder.group(Api, "server.lsp", (handlers) =>
  handlers.handle(
    "lsp.status",
    Effect.fn(function* () {
      const lsp = yield* LSPV2.Service
      return yield* response(lsp.status())
    }),
  ),
)
