import type { LspPresentation } from "@/context/global-sync/types"
import type { McpServer } from "@opencode-ai/client/promise"

export function hasServiceNeedingAttention(input: { mcp: Array<McpServer["status"]["status"]> }) {
  return input.mcp.some((status) => status === "needs_auth" || status === "needs_client_registration")
}

export function hasNonBlockingServiceIssue(input: {
  mcp: Array<McpServer["status"]["status"]>
  lsp: Array<LspPresentation["status"]>
}) {
  return (
    input.mcp.some((status) => status !== "connected" && status !== "pending" && status !== "disabled") ||
    input.lsp.some((status) => status === "error" || status === "missing")
  )
}

export function lspStatusDotClass(status: LspPresentation["status"]) {
  if (status === "connected") return "bg-icon-success-base"
  if (status === "error" || status === "missing") return "bg-icon-warning-base"
  return "bg-border-weak-base"
}

export function serverStatusDotClass(input: {
  ready: boolean
  serverHealth: boolean | undefined
  attention?: boolean
  issue: boolean
}) {
  if (input.serverHealth === false) return "bg-icon-critical-base"
  if (!input.ready || input.serverHealth === undefined) return "bg-border-weak-base"
  if (input.attention) return "bg-v2-background-bg-accent"
  if (input.issue) return "bg-icon-warning-base"
  if (input.serverHealth === true) return "bg-icon-success-base"
  return "bg-border-weak-base"
}
