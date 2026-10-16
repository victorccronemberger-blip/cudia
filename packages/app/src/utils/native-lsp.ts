import { OpenCode } from "@opencode-ai/runtime-client"
import type { LspStatusInput, LspStatusOutput } from "@opencode-ai/runtime-client"
import type { ServerConnection } from "@/context/server"
import { serverClientOptions } from "@/utils/server"

export type NativeLspApi = { readonly status: (input?: LspStatusInput) => Promise<LspStatusOutput> }

export function createNativeLspClient(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): NativeLspApi {
  return OpenCode.make(serverClientOptions(input)).lsp
}
