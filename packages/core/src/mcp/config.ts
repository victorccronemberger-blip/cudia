export * as MCPConfig from "./config"

import type { Config } from "../config"
import type { ConfigMCP } from "../config/mcp"

export type Server = typeof ConfigMCP.Server.Type

/** Resolve configured names without connecting or exposing connection secrets. */
export function resolve(entries: readonly Config.Entry[]) {
  const servers = new Map<string, Server>()
  let startup = 10_000
  let request = 30_000
  for (const entry of entries) {
    if (entry.type !== "document" || !entry.info.mcp) continue
    startup = entry.info.mcp.timeout?.startup ?? startup
    request = entry.info.mcp.timeout?.request ?? request
    for (const [name, server] of Object.entries(entry.info.mcp.servers ?? {})) servers.set(name, server)
  }
  return { servers: servers as ReadonlyMap<string, Server>, timeout: { startup, request } }
}
