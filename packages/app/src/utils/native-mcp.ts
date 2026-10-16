import {
  OpenCode,
  isInvalidRequestError,
  type IntegrationsAttemptCancelInput,
  type IntegrationsAttemptCancelOutput,
  type IntegrationsAttemptCompleteInput,
  type IntegrationsAttemptCompleteOutput,
  type IntegrationsAttemptStatusInput,
  type IntegrationsAttemptStatusOutput,
  type IntegrationsConnectOauthInput,
  type IntegrationsConnectOauthOutput,
  type McpConnectInput,
  type McpConnectOutput,
  type McpDisconnectInput,
  type McpDisconnectOutput,
  type McpListInput,
  type McpListOutput,
} from "@opencode-ai/runtime-client"
import type { McpServer } from "@opencode-ai/client/promise"
import type { ServerConnection } from "@/context/server"
import { serverClientOptions } from "@/utils/server"

export type NativeMcpClient = {
  mcp: {
    list: (input?: McpListInput) => Promise<McpListOutput>
    connect: (input: McpConnectInput) => Promise<McpConnectOutput>
    disconnect: (input: McpDisconnectInput) => Promise<McpDisconnectOutput>
  }
  integrations: {
    connectOauth: (input: IntegrationsConnectOauthInput) => Promise<IntegrationsConnectOauthOutput>
    attemptStatus: (input: IntegrationsAttemptStatusInput) => Promise<IntegrationsAttemptStatusOutput>
    attemptComplete: (input: IntegrationsAttemptCompleteInput) => Promise<IntegrationsAttemptCompleteOutput>
    attemptCancel: (input: IntegrationsAttemptCancelInput) => Promise<IntegrationsAttemptCancelOutput>
  }
}
export type NativeMcpInfo = McpListOutput["data"][number]
export type NativeMcpListApi = {
  mcp: Pick<NativeMcpClient["mcp"], "list">
}
export type McpPresentation = {
  status: McpServer["status"]["status"]
  error?: string
  nativeStatus?: NativeMcpInfo["status"]
  authentication?: NativeMcpInfo["authentication"]
  toolCount?: number
  exposureCount?: number
}

export function isNativeMcpAuthenticationRequired(error: unknown) {
  return isInvalidRequestError(error) && error.kind === "mcp_authentication_required"
}

export function createNativeMcpClient(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): NativeMcpClient {
  return OpenCode.make(serverClientOptions(input))
}

export async function mutateNativeMcp(input: {
  client: NativeMcpClient
  server: string
  directory: string
  action: "connect" | "disconnect"
  refresh: () => Promise<unknown>
}) {
  const result = await input.client.mcp[input.action]({
    server: input.server,
    location: { directory: input.directory },
  }).then(
    () => ({ ok: true as const }),
    (error: unknown) => ({ ok: false as const, error }),
  )
  if (!result.ok) {
    await input.refresh().catch(() => undefined)
    throw result.error
  }
  await input.refresh()
}

export function presentNativeMcp(info: NativeMcpInfo): McpPresentation {
  const status = ({
    disabled: "disabled",
    disconnected: "disabled",
    connecting: "pending",
    connected: "connected",
    failed: "failed",
    authentication_required: "needs_auth",
  } as const)[info.status]

  return {
    status,
    error: info.error?.message,
    nativeStatus: info.status,
    authentication: info.authentication,
    toolCount: info.toolCount,
    exposureCount: info.exposureCount,
  }
}
