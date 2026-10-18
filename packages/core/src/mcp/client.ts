export * as MCPClient from "./client"

import { Effect, Exit, Result } from "effect"
import type { JsonSchema, Scope } from "effect"
import type { MCPConfig } from "./config"
import { MCPError } from "./error"
import { isReaCommand } from "./rea-command"
import type { Compiler } from "../tool/json-input"
import type {
  CallToolResult,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from "@modelcontextprotocol/sdk/types.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation/types.js"

export type Definition = Tool
export type Result = CallToolResult
export type { ReadResourceResult, Resource, ResourceTemplate }
export type ResourceResult = ReadResourceResult
export const MAX_RESOURCE_BYTES = 8 * 1024 * 1024

export type Handle = {
  readonly instructions: () => Effect.Effect<string | undefined>
  readonly list: () => Effect.Effect<readonly Definition[], MCPError.Failure>
  readonly call: (name: string, args: Record<string, unknown>) => Effect.Effect<Result, MCPError.Failure>
  readonly resources: () => Effect.Effect<
    { readonly supported: boolean; readonly items: readonly Resource[] },
    MCPError.Failure
  >
  readonly templates: () => Effect.Effect<
    { readonly supported: boolean; readonly items: readonly ResourceTemplate[] },
    MCPError.Failure
  >
  readonly read: (uri: string) => Effect.Effect<ResourceResult, MCPError.Failure>
}

export function open(input: {
  readonly server: MCPConfig.Server
  readonly directory: string
  readonly timeout: { readonly startup: number; readonly request: number }
  readonly onClose: () => void
  readonly onToolsChanged: () => void
  readonly onResourcesChanged?: () => void
  readonly compiler: Compiler
  readonly authorization?: () => string | undefined
}): Effect.Effect<Handle, MCPError.Failure, Scope.Scope> {
  return Effect.gen(function* () {
    const [
      { Client },
      { StdioClientTransport },
      { StreamableHTTPClientTransport },
      { SSEClientTransport },
      { ErrorCode },
    ] = yield* Effect.tryPromise({
      try: () =>
        Promise.all([
          import("@modelcontextprotocol/sdk/client/index.js"),
          import("@modelcontextprotocol/sdk/client/stdio.js"),
          import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
          import("@modelcontextprotocol/sdk/client/sse.js"),
          import("@modelcontextprotocol/sdk/types.js"),
        ]),
      catch: () => failure("unavailable", "MCP transport is unavailable"),
    })

    type Connection = {
      readonly client: InstanceType<typeof Client>
      readonly transport: Transport
      readonly stdio?: InstanceType<typeof StdioClientTransport>
      readonly closed: Promise<void>
      readonly close: () => Promise<void>
      notifyOnClose: boolean
      pidAtStart?: number | null
    }

    const connections: Connection[] = []
    const close = async () => {
      for (const connection of connections.toReversed()) await connection.close()
    }

    yield* Effect.acquireRelease(Effect.succeed(undefined), () => Effect.promise(close))

    const newClient = () =>
      new Client(
        { name: "cudia", version: "1.0.0" },
        {
          jsonSchemaValidator: {
            getValidator<T>(raw: JsonSchemaType) {
              let validate: ((value: unknown) => boolean) | undefined
              return (value) => {
                try {
                  validate ??= input.compiler.compile(raw as unknown as JsonSchema.JsonSchema).validate
                  return validate(value)
                    ? { valid: true, data: value as T, errorMessage: undefined }
                    : { valid: false, data: undefined, errorMessage: "Invalid MCP output" }
                } catch {
                  return { valid: false, data: undefined, errorMessage: "Invalid MCP output schema" }
                }
              }
            },
          },
          listChanged: {
            tools: {
              autoRefresh: false,
              debounceMs: 0,
              onChanged: () => input.onToolsChanged(),
            },
            resources: {
              autoRefresh: false,
              debounceMs: 0,
              onChanged: () => input.onResourcesChanged?.(),
            },
          },
        },
      )

    const attach = (transport: Transport, stdio?: InstanceType<typeof StdioClientTransport>): Connection => {
      let resolveClosed = () => {}
      let called = false
      const closed = new Promise<void>((resolve) => (resolveClosed = resolve))
      let connection: Connection
      transport.onclose = () => {
        resolveClosed()
        if (called || !connection.notifyOnClose) return
        called = true
        input.onClose()
      }
      let closing: Promise<void> | undefined
      connection = {
        client: newClient(),
        transport,
        ...(stdio ? { stdio } : {}),
        closed,
        notifyOnClose: false,
        close: () => {
          if (closing) return closing
          closing = (async () => {
            await Promise.allSettled([connection.client.close(), connection.transport.close()])
            if (connection.pidAtStart !== undefined && connection.pidAtStart !== null) await connection.closed
          })()
          return closing
        },
      }
      connections.push(connection)
      if (stdio) {
        if (stdio.stderr) stdio.stderr.on("data", () => {})
        const start = transport.start.bind(transport)
        transport.start = async () => {
          await start()
          connection.pidAtStart = stdio.pid
        }
      }
      return connection
    }

    const connect = (connection: Connection) =>
      Effect.tryPromise({
        try: (signal) =>
          new Promise<void>((resolve, reject) => {
            const controller = new AbortController()
            const interrupt = () => controller.abort(signal.reason)
            signal.addEventListener("abort", interrupt, { once: true })
            const timer = setTimeout(() => {
              controller.abort()
              reject(new StartupTimeout())
            }, input.timeout.startup)
            connection.client
              .connect(connection.transport, {
                signal: controller.signal,
                timeout: input.timeout.startup,
                maxTotalTimeout: input.timeout.startup,
              })
              .then(() => {
                connection.notifyOnClose = true
                resolve()
              }, reject)
              .finally(() => {
                clearTimeout(timer)
                signal.removeEventListener("abort", interrupt)
              })
          }),
        catch: (cause) =>
          cause instanceof StartupTimeout || sdkCode(cause) === ErrorCode.RequestTimeout
            ? failure("timeout", "MCP startup timed out")
            : (cause instanceof HTTPStatusError && (cause.status === 401 || cause.status === 403)) ||
                sdkCode(cause) === 401 ||
                sdkCode(cause) === 403
              ? failure(
                  "authentication_required",
                  "MCP authentication is required; check configured headers or its OAuth integration",
                )
              : failure("startup", "MCP server failed to initialize"),
      })

    const attempt = (connection: Connection) =>
      Effect.onExit(connect(connection), (exit) =>
        Exit.isFailure(exit) ? Effect.promise(connection.close) : Effect.void,
      )

    if (input.server.type === "local") {
      const command = input.server.command[0]?.trim()
      if (!command) return yield* Effect.fail(failure("startup", "MCP command is empty"))
      const args = input.server.command.slice(1)
      const environment = input.server.environment
      const [{ resolve }, { StdioClientTransport: LocalTransport, getDefaultEnvironment }] = yield* Effect.tryPromise({
        try: () => Promise.all([import("node:path"), import("@modelcontextprotocol/sdk/client/stdio.js")]),
        catch: () => failure("unavailable", "MCP transport is unavailable"),
      })
      const local =
        command === "cudia:browser"
          ? yield* Effect.gen(function* () {
              const { prepare } = yield* Effect.tryPromise({
                try: () => import("./managed-browser"),
                catch: () => failure("unavailable", "Managed browser preparation is unavailable"),
              })
              return yield* prepare(args, environment, getDefaultEnvironment()).pipe(
                Effect.mapError((error) => failure("startup", error.message)),
              )
            })
          : command === "cudia:rea"
            ? yield* Effect.gen(function* () {
                const { prepare } = yield* Effect.tryPromise({
                  try: () => import("./managed-rea"),
                  catch: () => failure("unavailable", "Managed REA preparation is unavailable"),
                })
                return yield* prepare(args, environment, getDefaultEnvironment()).pipe(
                  Effect.mapError((error) => failure("startup", error.message)),
                )
              })
            : { command, args, env: environment }
      const env = isReaCommand(local.command, local.args)
        ? yield* Effect.gen(function* () {
            const { environmentFor } = yield* Effect.tryPromise({
              try: () => import("./rea-tools"),
              catch: () => failure("unavailable", "REA tool discovery is unavailable"),
            })
            return yield* Effect.tryPromise({
              try: (signal) => environmentFor(local.command, local.args, local.env, undefined, undefined, signal),
              catch: () => failure("startup", "Could not resolve the REA launch environment"),
            })
          })
        : local.env
      const transport = new LocalTransport({
        ...local,
        env,
        cwd: resolve(input.directory, input.server.cwd ?? "."),
        stderr: "pipe",
      })
      const connection = attach(transport, transport)
      yield* attempt(connection)
    }

    if (input.server.type === "remote") {
      const url = parseServerURL(input.server.url)
      if (!url) return yield* Effect.fail(failure("startup", "MCP server URL is invalid"))
      let lastHTTPStatus: number | undefined
      const fetch = secureFetch(url, (status) => (lastHTTPStatus = status), input.authorization)
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: input.server.headers, redirect: "manual" },
        fetch,
      })
      const connection = attach(transport)
      const connected = yield* Effect.result(attempt(connection))
      if (Result.isFailure(connected)) {
        const status = lastHTTPStatus
        if (connected.failure.kind === "authentication_required") return yield* Effect.fail(connected.failure)
        if (status !== 404 && status !== 405) return yield* Effect.fail(connected.failure)
        yield* Effect.promise(connection.close)
        const legacy = new SSEClientTransport(url, {
          requestInit: { headers: input.server.headers, redirect: "manual" },
          eventSourceInit: { fetch },
          fetch,
        })
        const legacyConnection = attach(legacy)
        yield* attempt(legacyConnection)
      }
    }

    const connection = connections.at(-1)
    if (!connection) return yield* Effect.fail(failure("unavailable", "MCP connection is unavailable"))

    const listCatalog = <T>(
      label: string,
      pageRequest: (
        cursor: string | undefined,
        options: { readonly signal: AbortSignal; readonly timeout: number; readonly maxTotalTimeout: number },
      ) => Promise<{ readonly items: readonly T[]; readonly nextCursor?: string; readonly decoded: unknown }>,
    ) =>
      Effect.tryPromise({
        try: async (signal) => {
          const items: T[] = []
          const cursors = new Set<string>()
          let cursor: string | undefined
          let pages = 0
          let byteLength = 0
          do {
            if (++pages > 128 || (cursor !== undefined && cursors.has(cursor))) throw new CatalogLimit()
            if (cursor !== undefined) cursors.add(cursor)
            const page = await pageRequest(cursor, {
              signal,
              timeout: input.timeout.request,
              maxTotalTimeout: input.timeout.request,
            })
            const pageBytes = Buffer.byteLength(JSON.stringify(page.decoded))
            if (items.length + page.items.length > 1_000 || byteLength + pageBytes > 1024 * 1024)
              throw new CatalogLimit()
            items.push(...page.items)
            byteLength += pageBytes
            cursor = page.nextCursor
          } while (cursor !== undefined)
          return items
        },
        catch: (cause) =>
          cause instanceof CatalogLimit
            ? failure("catalog", `MCP ${label} catalog exceeds its safety limit`)
            : (cause instanceof HTTPStatusError && (cause.status === 401 || cause.status === 403)) ||
                sdkCode(cause) === 401 ||
                sdkCode(cause) === 403
              ? failure(
                  "authentication_required",
                  "MCP authentication is required; check configured headers or its OAuth integration",
                )
              : sdkCode(cause) === ErrorCode.RequestTimeout
                ? failure("timeout", `MCP ${label} catalog request timed out`)
                : failure("request", `MCP ${label} catalog request failed`),
      }).pipe(
        Effect.timeoutOrElse({
          duration: input.timeout.request,
          orElse: () => Effect.fail(failure("timeout", `MCP ${label} catalog discovery timed out`)),
        }),
      )

    const handle: Handle = {
      instructions: () => Effect.sync(() => connection.client.getInstructions()),
      list: () =>
        Effect.tryPromise({
          try: async (signal) => {
            if (!connection.client.getServerCapabilities()?.tools) return []
            const tools: Definition[] = []
            let cursor: string | undefined
            let pages = 0
            let byteLength = 0
            do {
              if (++pages > 128) throw new CatalogLimit()
              const page = await connection.client.listTools(cursor ? { cursor } : undefined, {
                signal,
                timeout: input.timeout.request,
                maxTotalTimeout: input.timeout.request,
              })
              tools.push(...page.tools)
              byteLength += new TextEncoder().encode(JSON.stringify(page)).byteLength
              if (tools.length > 1_000 || byteLength > 1024 * 1024) throw new CatalogLimit()
              cursor = page.nextCursor
            } while (cursor)
            return tools
          },
          catch: (cause) =>
            cause instanceof CatalogLimit
              ? failure("catalog", "MCP tool catalog exceeds its safety limit")
              : (cause instanceof HTTPStatusError && (cause.status === 401 || cause.status === 403)) ||
                  sdkCode(cause) === 401 ||
                  sdkCode(cause) === 403
                ? failure(
                    "authentication_required",
                    "MCP authentication is required; check configured headers or its OAuth integration",
                  )
                : sdkCode(cause) === ErrorCode.RequestTimeout
                  ? failure("timeout", "MCP tool catalog request timed out")
                  : failure("request", "MCP tool catalog request failed"),
        }).pipe(
          Effect.timeoutOrElse({
            duration: input.timeout.request,
            orElse: () => Effect.fail(failure("timeout", "MCP tool catalog discovery timed out")),
          }),
        ),
      resources: () => {
        if (!connection.client.getServerCapabilities()?.resources)
          return Effect.succeed({ supported: false, items: [] })
        return listCatalog("resource", (cursor, options) =>
          connection.client.listResources(cursor === undefined ? undefined : { cursor }, options).then((page) => ({
            items: page.resources,
            nextCursor: page.nextCursor,
            decoded: page,
          })),
        ).pipe(Effect.map((items) => ({ supported: true, items })))
      },
      templates: () => {
        if (!connection.client.getServerCapabilities()?.resources)
          return Effect.succeed({ supported: false, items: [] })
        return listCatalog("resource template", (cursor, options) =>
          connection.client
            .listResourceTemplates(cursor === undefined ? undefined : { cursor }, options)
            .then((page) => ({
              items: page.resourceTemplates,
              nextCursor: page.nextCursor,
              decoded: page,
            })),
        ).pipe(Effect.map((items) => ({ supported: true, items })))
      },
      read: (uri) => {
        if (!connection.client.getServerCapabilities()?.resources)
          return Effect.fail(failure("unavailable", "MCP server does not support resources"))
        return Effect.tryPromise({
          try: async (signal) => {
            const result = await connection.client.readResource(
              { uri },
              {
                signal,
                timeout: input.timeout.request,
                maxTotalTimeout: input.timeout.request,
              },
            )
            if (Buffer.byteLength(JSON.stringify(result)) > MAX_RESOURCE_BYTES) throw new ResourceLimit()
            return result as ResourceResult
          },
          catch: (cause) =>
            cause instanceof ResourceLimit
              ? failure("budget", "MCP resource response exceeds its safety limit")
              : (cause instanceof HTTPStatusError && (cause.status === 401 || cause.status === 403)) ||
                  sdkCode(cause) === 401 ||
                  sdkCode(cause) === 403
                ? failure(
                    "authentication_required",
                    "MCP authentication is required; check configured headers or its OAuth integration",
                  )
                : sdkCode(cause) === ErrorCode.RequestTimeout
                  ? failure(
                      "timeout",
                      "MCP resource read timed out. Its external outcome is unknown; do not retry automatically.",
                    )
                  : failure("request", "MCP resource read request failed"),
        }).pipe(
          Effect.timeoutOrElse({
            duration: input.timeout.request,
            orElse: () =>
              Effect.fail(
                failure(
                  "timeout",
                  "MCP resource read timed out. Its external outcome is unknown; do not retry automatically.",
                ),
              ),
          }),
        )
      },
      call: (name, args) =>
        Effect.tryPromise({
          try: (signal) =>
            connection.client.callTool({ name, arguments: args }, undefined, {
              signal,
              timeout: input.timeout.request,
              maxTotalTimeout: input.timeout.request,
            }) as Promise<Result>,
          catch: (cause) =>
            (cause instanceof HTTPStatusError && (cause.status === 401 || cause.status === 403)) ||
            sdkCode(cause) === 401 ||
            sdkCode(cause) === 403
              ? failure(
                  "authentication_required",
                  "MCP authentication is required; check configured headers or its OAuth integration",
                )
              : sdkCode(cause) === ErrorCode.RequestTimeout
                ? failure(
                    "timeout",
                    "MCP tool request timed out. Its external outcome is unknown; do not retry automatically.",
                  )
                : failure(
                    "request",
                    "MCP tool request failed. Its external outcome is unknown; do not retry automatically.",
                  ),
        }),
    }
    return handle
  })
}

function failure(kind: MCPError.Failure["kind"], message: string) {
  return new MCPError.Failure({ kind, message })
}

class StartupTimeout extends Error {}
class CatalogLimit extends Error {}
class ResourceLimit extends Error {}
class HTTPStatusError extends Error {
  constructor(readonly status: number) {
    super("MCP HTTP request failed")
  }
}

function sdkCode(cause: unknown) {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined
  return typeof cause.code === "number" ? cause.code : undefined
}

function parseServerURL(value: string) {
  try {
    const url = new URL(value)
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash)
      return undefined
    return url
  } catch {
    return undefined
  }
}

function secureFetch(
  base: URL,
  onStatus: (status: number) => void,
  authorization?: () => string | undefined,
): import("@modelcontextprotocol/sdk/shared/transport.js").FetchLike {
  return async (target, init) => {
    let current = new URL(target)
    if (current.origin !== base.origin) throw new HTTPStatusError(0)
    const headers = new Headers(init?.headers)
    const bearer = headers.has("authorization") ? undefined : authorization?.()
    if (bearer) headers.set("authorization", `Bearer ${bearer}`)
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await fetch(current, { ...init, headers, redirect: "manual" })
      const method = init?.method?.toUpperCase()
      if (
        method !== "GET" &&
        (response.status === 401 || response.status === 403 || response.status === 404 || response.status === 405)
      ) {
        onStatus(response.status)
        throw new HTTPStatusError(response.status)
      }
      if (response.status !== 307 && response.status !== 308) return response
      const location = response.headers.get("location")
      if (!location) return response
      const next = new URL(location, current)
      if (next.origin !== base.origin) throw new HTTPStatusError(0)
      if (redirects === 5) throw new HTTPStatusError(400)
      current = next
    }
    throw new HTTPStatusError(400)
  }
}
