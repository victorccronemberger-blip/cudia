import { OpenCode } from "@opencode-ai/runtime-client"
import type {
  AgentsListInput,
  AgentsListOutput,
  ModelsDefaultInput,
  ModelsDefaultOutput,
  ModelsListInput,
  ModelsListOutput,
  ProvidersListInput,
  ProvidersListOutput,
} from "@opencode-ai/runtime-client"
import type { ServerConnection } from "@/context/server"
import { serverClientOptions } from "@/utils/server"

export type NativeAgentListApi = {
  list: (input?: AgentsListInput) => Promise<AgentsListOutput>
}
export type NativeModelCatalogApi = {
  list: (input?: ModelsListInput) => Promise<ModelsListOutput>
  default: (input?: ModelsDefaultInput) => Promise<ModelsDefaultOutput>
}
export type NativeProviderListApi = {
  list: (input?: ProvidersListInput) => Promise<ProvidersListOutput>
}
export type NativeCatalogClient = {
  agents: NativeAgentListApi
  models: NativeModelCatalogApi
  providers: NativeProviderListApi
}

export function createNativeCatalogClient(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): NativeCatalogClient {
  return OpenCode.make(serverClientOptions(input))
}
