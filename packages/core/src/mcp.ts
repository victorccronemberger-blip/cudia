export * as MCPV2 from "./mcp"

import { createHash, randomUUID } from "node:crypto"
import { MCP } from "@opencode-ai/schema/mcp"
import { Context, Effect, Exit, Layer, Schema, Scope, Semaphore } from "effect"
import { Config } from "./config"
import { makeLocationNode } from "./effect/app-node"
import { EventV2 } from "./event"
import { Location } from "./location"
import { Integration } from "./integration"
import { PermissionV2 } from "./permission"
import { SessionSchema } from "./session/schema"
import { SessionStore } from "./session/store"
import { SkillCatalog } from "./skill/catalog"
import { Tool } from "./tool/tool"
import { ToolRegistry } from "./tool/registry"
import { Tools } from "./tool/tools"
import { SessionV1 } from "./v1/session"
import { MCPClient } from "./mcp/client"
import { MCPConfig } from "./mcp/config"
import { MCPContent } from "./mcp/content"
import { MCPError } from "./mcp/error"
import { MCPOAuth } from "./mcp/oauth"
import { MCPResourceCatalog } from "./mcp/resource-catalog"

export const MAX_EXPOSED = 32
export const MAX_DEFINITION_BYTES = 32 * 1024
export type ResourceResult = MCPClient.ResourceResult
type Error = MCPError.Failure | Effect.Error<ReturnType<PermissionV2.Interface["assert"]>>
type Status = "disabled" | "disconnected" | "connecting" | "connected" | "failed" | "authentication_required"
type Page = { readonly query: string; readonly offset?: number; readonly limit?: number }
export type Summary = {
  readonly name: string
  readonly status: Status
  readonly tools: number
  readonly exposed: number
  readonly authentication?: MCPOAuth.Profile
}
type Exposure = {
  readonly scope: Scope.Closeable
  readonly name: string
  readonly bytes: number
  readonly tool: Tool.AnyTool
}
type Connection = {
  readonly scope: Scope.Closeable
  readonly exposed: Map<SessionSchema.ID, Map<string, Exposure>>
  catalog: ReadonlyMap<string, MCPClient.Definition>
  handle?: MCPClient.Handle
  active: boolean
  closed: boolean
  revision: number
  dirty: boolean
  readonly resourceEpoch: string
  readonly resourceLock: Semaphore.Semaphore
  resourceRevision: number
  readonly resources: Partial<
    Record<
      MCPResourceCatalog.Kind,
      {
        readonly revision: number
        readonly supported: boolean
        readonly items: readonly MCPResourceCatalog.Item[]
        readonly token: string
      }
    >
  >
}
type State = {
  readonly config: MCPConfig.Server
  readonly lock: Semaphore.Semaphore
  status: Status
  connection?: Connection
  error?: MCP.Failure
}

export interface Interface {
  readonly admin: {
    readonly list: () => Effect.Effect<readonly MCP.Server[]>
    readonly connect: (server: string) => Effect.Effect<void, MCPError.Failure>
    readonly disconnect: (server: string) => Effect.Effect<void, MCPError.Failure>
  }
  readonly servers: (page: Page, context: Tool.Context) => Effect.Effect<unknown, Error>
  readonly connect: (server: string, context: Tool.Context) => Effect.Effect<Summary, Error>
  readonly disconnect: (server: string, context: Tool.Context) => Effect.Effect<{ readonly removed: number }, Error>
  readonly search: (server: string, page: Page, context: Tool.Context) => Effect.Effect<unknown, Error>
  readonly resources: (
    server: string,
    page: MCPResourceCatalog.Page,
    context: Tool.Context,
  ) => Effect.Effect<unknown, Error>
  readonly templates: (
    server: string,
    page: MCPResourceCatalog.Page,
    context: Tool.Context,
  ) => Effect.Effect<unknown, Error>
  readonly read: (server: string, uri: string, context: Tool.Context) => Effect.Effect<MCPClient.ResourceResult, Error>
  readonly expose: (server: string, names: readonly string[], context: Tool.Context) => Effect.Effect<unknown, Error>
  readonly hide: (
    server: string,
    names: readonly string[],
    context: Tool.Context,
  ) => Effect.Effect<{ readonly removed: number }, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/MCP") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const permission = yield* PermissionV2.Service
    const tools = yield* Tools.Service
    const sessions = yield* SessionStore.Service
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const oauth = yield* MCPOAuth.Service
    const lifetime = yield* Scope.Scope
    const configured = MCPConfig.resolve(yield* config.entries())
    const states = new Map(
      [...configured.servers].map(
        ([name, server]) =>
          [
            name,
            {
              config: server,
              lock: Semaphore.makeUnsafe(1),
              status: server.disabled ? "disabled" : "disconnected",
            } satisfies State,
          ] as const,
      ),
    ) as Map<string, State>
    const deleted = new Set<SessionSchema.ID>()
    const exposureLock = Semaphore.makeUnsafe(1)
    let disposed = false

    const assert = (
      action: string,
      resources: readonly string[],
      context: Tool.Context,
      metadata: Record<string, unknown>,
    ) =>
      permission.assert({
        action,
        resources: [...resources],
        save: [...resources],
        metadata,
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
      })
    const state = (name: string) =>
      Effect.suspend(() => {
        const current = states.get(name)
        return !disposed && name.length > 0 && name.isWellFormed() && current
          ? Effect.succeed(current)
          : Effect.fail(
              new MCPError.Failure({
                kind: "not_configured",
                message: "MCP server is not configured in this location",
              }),
            )
      })
    const current = (entry: State) =>
      Effect.suspend(() =>
        entry.connection?.active && entry.connection.handle
          ? Effect.succeed(entry.connection)
          : Effect.fail(
              new MCPError.Failure({
                kind: "disconnected",
                message: "Connect this MCP server before using its catalog",
              }),
            ),
      )
    const closeExposures = (connection: Connection, sessionID?: SessionSchema.ID) =>
      Effect.gen(function* () {
        const scopes: Scope.Closeable[] = []
        for (const [id, exposed] of connection.exposed) {
          if (sessionID !== undefined && id !== sessionID) continue
          for (const value of exposed.values()) scopes.push(value.scope)
          connection.exposed.delete(id)
        }
        yield* Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), { discard: true })
        return scopes.length
      })
    const summary = (name: string, entry: State, sessionID: SessionSchema.ID): Summary => ({
      name,
      status: entry.status,
      tools: entry.connection?.catalog.size ?? 0,
      exposed: entry.connection?.exposed.get(sessionID)?.size ?? 0,
      authentication: oauth.profile(name),
    })
    const refresh = (connection: Connection) =>
      Effect.gen(function* () {
        if (!connection.dirty) return
        const revision = connection.revision
        const catalog = yield* connection.handle!.list()
        yield* closeExposures(connection)
        connection.catalog = yield* catalogMap(catalog)
        connection.dirty = connection.revision !== revision
        if (connection.dirty)
          return yield* new MCPError.Failure({
            kind: "stale",
            message: "MCP catalog changed during refresh; search again",
          })
      })
    const liveSession = (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        const session = yield* sessions.get(sessionID)
        if (
          deleted.has(sessionID) ||
          !session ||
          session.location.directory !== location.directory ||
          session.location.workspaceID !== location.workspaceID
        )
          return yield* new MCPError.Failure({
            kind: "unavailable",
            message: "The requesting session is no longer available",
          })
      })

    yield* events.project(SessionV1.Event.Deleted, (event) =>
      Effect.gen(function* () {
        const sessionID = SessionSchema.ID.make(event.data.sessionID)
        deleted.add(sessionID)
        for (const entry of states.values()) if (entry.connection) yield* closeExposures(entry.connection, sessionID)
      }),
    )
    yield* Effect.acquireRelease(
      events.listen((event) =>
        Effect.gen(function* () {
          if (event.type !== Integration.Event.ConnectionUpdated.type) return
          const data = Schema.decodeUnknownSync(Integration.Event.ConnectionUpdated.data)(event.data)
          for (const [name, entry] of states) {
            if (oauth.profile(name)?.integrationID !== data.integrationID) continue
            const connection = entry.connection
            if (!connection) continue
            connection.active = false
            entry.connection = undefined
            entry.status = "disconnected"
            entry.error = undefined
            yield* closeExposures(connection)
            yield* Scope.close(connection.scope, Exit.void).pipe(Effect.forkIn(lifetime), Effect.asVoid)
          }
        }),
      ),
      (unsubscribe) => unsubscribe,
    )
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        disposed = true
        for (const entry of states.values()) {
          const connection = entry.connection
          if (!connection) continue
          connection.active = false
          yield* closeExposures(connection)
          yield* Scope.close(connection.scope, Exit.void)
          entry.connection = undefined
        }
      }),
    )

    const resourceConnection = (entry: State, connection: Connection, context: Tool.Context) =>
      Effect.gen(function* () {
        yield* liveSession(context.sessionID)
        if (disposed || !connection.active || entry.connection !== connection)
          return yield* new MCPError.Failure({
            kind: "stale",
            message: "MCP connection changed during the resource operation; do not retry automatically",
          })
      })
    const resourceCatalog = (
      kind: MCPResourceCatalog.Kind,
      name: string,
      page: MCPResourceCatalog.Page,
      context: Tool.Context,
    ) =>
      Effect.gen(function* () {
        const offset = page.offset ?? 0
        const limit = page.limit ?? 8
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(limit) ||
          limit < 1 ||
          limit > MCPResourceCatalog.MAX_PAGE_SIZE ||
          Buffer.byteLength(page.query) > MCPResourceCatalog.MAX_QUERY_BYTES
        )
          return yield* new MCPError.Failure({
            kind: "budget",
            message: "MCP resource query or page exceeds its limit",
          })
        if (offset > 0 && !page.snapshot)
          return yield* new MCPError.Failure({
            kind: "stale",
            message: "Pass the resource snapshot from the first page when continuing",
          })
        const entry = yield* state(name)
        yield* assert(
          kind === "resources" ? "mcp.resources" : "mcp.resource.templates",
          [serverResource(name)],
          context,
          { server: name },
        )
        yield* liveSession(context.sessionID)
        const connection = yield* current(entry)
        return yield* connection.resourceLock.withPermit(
          Effect.gen(function* () {
            yield* resourceConnection(entry, connection, context)
            const revision = connection.resourceRevision
            const snapshot = (token: string) =>
              createHash("sha256")
                .update(JSON.stringify([token, page.query]))
                .digest("hex")
            const stored = connection.resources[kind]
            if (page.snapshot !== undefined) {
              if (!stored || stored.revision !== revision || page.snapshot !== snapshot(stored.token))
                return yield* new MCPError.Failure({
                  kind: "stale",
                  message: "MCP resource catalog or query changed; request the first page again",
                })
              return stored.supported
                ? MCPResourceCatalog.search(kind, stored.items, page, page.snapshot)
                : { supported: false, matches: [], total: 0 }
            }
            yield* oauth.prepare(name)
            yield* resourceConnection(entry, connection, context)
            if (connection.resourceRevision !== revision)
              return yield* new MCPError.Failure({
                kind: "stale",
                message: "MCP resource catalog changed before discovery; request it again",
              })
            const result = yield* kind === "resources" ? connection.handle!.resources() : connection.handle!.templates()
            yield* resourceConnection(entry, connection, context)
            if (connection.resourceRevision !== revision)
              return yield* new MCPError.Failure({
                kind: "stale",
                message: "MCP resource catalog changed during discovery; request it again",
              })
            const items = yield* Effect.try({
              try: () => MCPResourceCatalog.catalog(kind, result.items),
              catch: () =>
                new MCPError.Failure({
                  kind: "catalog",
                  message: "MCP resource catalog contains invalid or duplicate identities",
                }),
            })
            const token = createHash("sha256")
              .update(JSON.stringify([connection.resourceEpoch, revision, kind, items]))
              .digest("hex")
            connection.resources[kind] = { supported: result.supported, items, revision, token }
            return result.supported
              ? MCPResourceCatalog.search(kind, items, page, snapshot(token))
              : { supported: false, matches: [], total: 0 }
          }),
        )
      })

    // Operator controls and model tools share one lock and transport. Only model
    // callers carry a session admission guard and pass through native permissions.
    const connect = (name: string, entry: State, admission: Effect.Effect<void, MCPError.Failure>) =>
      entry.lock.withPermit(
        Effect.gen(function* () {
          if (disposed) return yield* new MCPError.Failure({ kind: "disconnected", message: "MCP location is closed" })
          yield* admission
          if (entry.connection?.active) return
          if (entry.connection) yield* Scope.close(entry.connection.scope, Exit.void)
          const scope = yield* Scope.make()
          const connection: Connection = {
            scope,
            active: false,
            closed: false,
            revision: 0,
            dirty: false,
            catalog: new Map(),
            exposed: new Map(),
            resourceEpoch: randomUUID(),
            resourceLock: Semaphore.makeUnsafe(1),
            resourceRevision: 0,
            resources: {},
          }
          entry.connection = connection
          entry.status = "connecting"
          entry.error = undefined
          return yield* Effect.gen(function* () {
            yield* oauth.prepare(name)
            const { load } = yield* Effect.promise(() => import("./tool/json-input"))
            const compiler = yield* load()
            connection.handle = yield* MCPClient.open({
              server: entry.config,
              directory: location.directory,
              compiler,
              authorization: () => oauth.bearer(name),
              timeout: {
                startup: entry.config.timeout?.startup ?? configured.timeout.startup,
                request: entry.config.timeout?.request ?? configured.timeout.request,
              },
              onClose: () => {
                connection.active = false
                connection.closed = true
                if (entry.connection === connection && entry.status === "connected") entry.status = "disconnected"
                Effect.runFork(closeExposures(connection))
              },
              onToolsChanged: () => {
                connection.dirty = true
                connection.revision++
              },
              onResourcesChanged: () => {
                connection.resourceRevision++
                delete connection.resources.resources
                delete connection.resources.templates
              },
            })
            const catalog = yield* connection.handle.list()
            const definitions = yield* catalogMap(catalog)
            yield* admission
            if (disposed || connection.closed || entry.connection !== connection)
              return yield* new MCPError.Failure({
                kind: "disconnected",
                message: "MCP location closed during startup",
              })
            connection.catalog = definitions
            connection.active = true
            entry.status = "connected"
          }).pipe(
            Effect.timeoutOrElse({
              duration: entry.config.timeout?.startup ?? configured.timeout.startup,
              orElse: () =>
                Effect.fail(
                  new MCPError.Failure({ kind: "timeout", message: "MCP startup and catalog discovery timed out" }),
                ),
            }),
            Effect.provideService(Scope.Scope, scope),
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : Effect.gen(function* () {
                    connection.active = false
                    if (entry.connection === connection) entry.status = "failed"
                    yield* closeExposures(connection)
                    yield* Scope.close(scope, exit)
                  }),
            ),
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (entry.connection !== connection) return
                entry.status = error.kind === "authentication_required" ? "authentication_required" : "failed"
                entry.error = { kind: error.kind, message: error.message }
              }),
            ),
          )
        }),
      )
    const disconnect = (entry: State) =>
      entry.lock.withPermit(
        Effect.gen(function* () {
          const connection = entry.connection
          entry.status = "disconnected"
          entry.error = undefined
          if (!connection) return { removed: 0 }
          connection.active = false
          const removed = yield* closeExposures(connection)
          yield* Scope.close(connection.scope, Exit.void)
          if (entry.connection === connection) entry.connection = undefined
          return { removed }
        }),
      )

    return Service.of({
      admin: {
        list: () =>
          Effect.sync(() =>
            [...states].map(([name, entry]) => ({
              name,
              status: entry.status,
              toolCount: entry.connection?.catalog.size ?? 0,
              exposureCount: [...(entry.connection?.exposed.values() ?? [])].reduce(
                (total, exposed) => total + exposed.size,
                0,
              ),
              authentication: oauth.profile(name),
              error: entry.error,
            })),
          ),
        connect: (name) =>
          Effect.gen(function* () {
            const entry = yield* state(name)
            yield* connect(name, entry, Effect.void)
          }),
        disconnect: (name) =>
          Effect.gen(function* () {
            const entry = yield* state(name)
            yield* disconnect(entry)
          }),
      },
      servers: (page, context) =>
        Effect.gen(function* () {
          yield* validNames([...states.keys()])
          yield* assert("mcp.servers", [...states.keys()].map(serverResource), context, { servers: [...states.keys()] })
          const result = SkillCatalog.search(
            [...states.keys()].map((name) => ({ name })),
            page,
          )
          return {
            ...result,
            matches: result.matches.map((item) => summary(item.name, states.get(item.name)!, context.sessionID)),
          }
        }),
      connect: (name, context) =>
        Effect.gen(function* () {
          const entry = yield* state(name)
          yield* assert("mcp.connect", [serverResource(name)], context, { server: name })
          yield* connect(name, entry, liveSession(context.sessionID))
          return summary(name, entry, context.sessionID)
        }),
      disconnect: (name, context) =>
        Effect.gen(function* () {
          const entry = yield* state(name)
          yield* assert("mcp.disconnect", [serverResource(name)], context, { server: name })
          return yield* disconnect(entry)
        }),
      search: (name, page, context) =>
        Effect.gen(function* () {
          const entry = yield* state(name)
          yield* assert("mcp.search", [serverResource(name)], context, { server: name })
          return yield* entry.lock.withPermit(
            Effect.gen(function* () {
              const connection = yield* current(entry)
              if (connection.dirty) yield* oauth.prepare(name)
              yield* refresh(connection)
              return SkillCatalog.search(
                [...connection.catalog.values()].map((tool) => ({ name: tool.name, description: tool.description })),
                page,
              )
            }),
          )
        }),
      resources: (name, page, context) => resourceCatalog("resources", name, page, context),
      templates: (name, page, context) => resourceCatalog("templates", name, page, context),
      read: (name, uri, context) =>
        Effect.gen(function* () {
          if (!uri || !uri.isWellFormed() || Buffer.byteLength(uri) > MCPResourceCatalog.MAX_URI_BYTES)
            return yield* new MCPError.Failure({
              kind: "budget",
              message: "MCP resource URI must be nonempty, well-formed Unicode within 8192 UTF-8 bytes",
            })
          const entry = yield* state(name)
          yield* assert("mcp.resource.read", [resource(name, uri)], context, { server: name, uri })
          yield* liveSession(context.sessionID)
          const connection = yield* current(entry)
          yield* oauth.prepare(name)
          yield* resourceConnection(entry, connection, context)
          const result = yield* connection.handle!.read(uri)
          yield* resourceConnection(entry, connection, context)
          return result
        }),
      expose: (name, requested, context) =>
        Effect.gen(function* () {
          const entry = yield* state(name)
          const names = [...new Set(requested)]
          yield* validNames(names)
          if (!names.length || names.length > 8)
            return yield* new MCPError.Failure({
              kind: "budget",
              message: "Expose between one and eight named MCP tools per request",
            })
          yield* assert(
            "mcp.expose",
            names.map((tool) => resource(name, tool)),
            context,
            { server: name, tools: names },
          )
          return yield* entry.lock.withPermit(
            exposureLock.withPermit(
              Effect.gen(function* () {
                yield* liveSession(context.sessionID)
                const connection = yield* current(entry)
                if (connection.dirty) yield* oauth.prepare(name)
                yield* refresh(connection)
                const existing = connection.exposed.get(context.sessionID) ?? new Map<string, Exposure>()
                const prepared = new Map<
                  string,
                  { readonly name: string; readonly tool: Tool.AnyTool; readonly bytes: number }
                >()
                for (const original of names) {
                  if (existing.has(original)) continue
                  const definition = connection.catalog.get(original)
                  if (!definition)
                    return yield* new MCPError.Failure({
                      kind: "unavailable",
                      message: "Requested tool is not present in this MCP catalog",
                    })
                  const input = yield* Tool.jsonInput(definition.inputSchema).pipe(
                    Effect.mapError(
                      () =>
                        new MCPError.Failure({
                          kind: "invalid_schema",
                          message: "MCP tool input schema is unsupported or exceeds its limit",
                        }),
                    ),
                  )
                  if (definition.outputSchema) {
                    const { compile } = yield* Effect.promise(() => import("./tool/json-input"))
                    yield* compile(definition.outputSchema).pipe(
                      Effect.mapError(
                        () =>
                          new MCPError.Failure({
                            kind: "invalid_schema",
                            message: "MCP tool output schema is unsupported or exceeds its limit",
                          }),
                      ),
                    )
                  }
                  const publicName = toolName(name, original)
                  const tool: Tool.AnyTool = Tool.withPermission(
                    Tool.make({
                      description: (definition.description ?? `${name}: ${original}`).slice(0, 768),
                      input,
                      output: Schema.Record(Schema.String, Schema.Unknown),
                      toModelOutput: ({ output }) => MCPContent.render(output),
                      execute: (args, caller) =>
                        Effect.gen(function* () {
                          const exposed = connection.exposed.get(caller.sessionID)?.get(original)
                          if (
                            disposed ||
                            deleted.has(caller.sessionID) ||
                            entry.connection !== connection ||
                            !connection.active ||
                            connection.dirty ||
                            exposed?.tool !== tool
                          )
                            return yield* new Tool.Failure({
                              message:
                                "MCP tool is no longer exposed for this session; search and expose again before calling it",
                            })
                          yield* assert("mcp.call", [resource(name, original)], caller, {
                            server: name,
                            tool: original,
                          })
                          yield* liveSession(caller.sessionID)
                          yield* oauth.prepare(name)
                          if (
                            deleted.has(caller.sessionID) ||
                            !connection.active ||
                            connection.dirty ||
                            entry.connection !== connection ||
                            connection.exposed.get(caller.sessionID)?.get(original)?.tool !== tool
                          )
                            return yield* new Tool.Failure({
                              message: "MCP connection changed before the call started",
                            })
                          const result = yield* connection.handle!.call(original, args)
                          // A catalog notification affects the next admission, not this completed reply.
                          if (
                            !connection.active ||
                            entry.connection !== connection ||
                            connection.exposed.get(caller.sessionID)?.get(original)?.tool !== tool
                          )
                            return yield* new Tool.Failure({
                              message:
                                "MCP connection changed while the call ran. Its external outcome may already have occurred; do not retry automatically.",
                            })
                          return result
                        }).pipe(
                          Effect.mapError((error) =>
                            error instanceof Tool.Failure
                              ? error
                              : new Tool.Failure({
                                  message:
                                    error instanceof MCPError.Failure
                                      ? error.message
                                      : error instanceof PermissionV2.CorrectedError
                                        ? error.feedback
                                        : "MCP call denied or session unavailable",
                                }),
                          ),
                        ),
                    }),
                    "mcp.call",
                  )
                  prepared.set(original, {
                    name: publicName,
                    tool,
                    bytes: new TextEncoder().encode(JSON.stringify(Tool.definition(publicName, tool))).byteLength,
                  })
                }
                const active = [...states.values()].flatMap((state) => [
                  ...(state.connection?.exposed.get(context.sessionID)?.values() ?? []),
                ])
                const publicNames = [...active, ...prepared.values()].map((item) => item.name)
                if (new Set(publicNames).size !== publicNames.length)
                  return yield* new MCPError.Failure({
                    kind: "catalog",
                    message: "MCP public tool names collide; no tools were exposed",
                  })
                const bytes =
                  active.reduce((total, item) => total + item.bytes, 0) +
                  [...prepared.values()].reduce((total, item) => total + item.bytes, 0)
                if (active.length + prepared.size > MAX_EXPOSED || bytes > MAX_DEFINITION_BYTES)
                  return yield* new MCPError.Failure({
                    kind: "budget",
                    message: "MCP exposure budget exceeded; hide unused tools before exposing more",
                  })
                const pending: Scope.Closeable[] = []
                const next = new Map(existing)
                yield* Effect.uninterruptibleMask((restore) =>
                  Effect.gen(function* () {
                    for (const [original, value] of prepared) {
                      const scope = yield* Scope.make()
                      pending.push(scope)
                      yield* tools.register({ [value.name]: value.tool }, { sessionID: context.sessionID }).pipe(
                        Effect.provideService(Scope.Scope, scope),
                        Effect.mapError(
                          () =>
                            new MCPError.Failure({
                              kind: "unavailable",
                              message: "Unable to register requested MCP tools",
                            }),
                        ),
                      )
                      next.set(original, { ...value, scope })
                    }
                    yield* restore(liveSession(context.sessionID))
                    if (
                      disposed ||
                      deleted.has(context.sessionID) ||
                      !connection.active ||
                      connection.dirty ||
                      entry.connection !== connection
                    )
                      return yield* new MCPError.Failure({
                        kind: "stale",
                        message: "MCP catalog changed during tool exposure; search again",
                      })
                    connection.exposed.set(context.sessionID, next)
                  }).pipe(
                    Effect.onExit((exit) =>
                      Exit.isSuccess(exit)
                        ? Effect.void
                        : Effect.forEach(pending, (scope) => Scope.close(scope, exit), { discard: true }),
                    ),
                  ),
                )
                return {
                  tools: names.map((original) => ({ tool: original, name: next.get(original)!.name })),
                  definitionBytes: bytes,
                }
              }),
            ),
          )
        }),
      hide: (name, names, context) =>
        Effect.gen(function* () {
          const entry = yield* state(name)
          yield* validNames(names)
          yield* assert(
            "mcp.hide",
            names.map((tool) => resource(name, tool)),
            context,
            { server: name, tools: names },
          )
          return yield* entry.lock.withPermit(
            exposureLock.withPermit(
              Effect.gen(function* () {
                const exposed = entry.connection?.exposed.get(context.sessionID)
                let removed = 0
                for (const original of new Set(names)) {
                  const item = exposed?.get(original)
                  if (!item) continue
                  exposed!.delete(original)
                  yield* Scope.close(item.scope, Exit.void)
                  removed++
                }
                if (exposed?.size === 0) entry.connection?.exposed.delete(context.sessionID)
                return { removed }
              }),
            ),
          )
        }),
    })
  }),
)

export function toolName(server: string, tool: string) {
  return `mcp_${createHash("sha256")
    .update(JSON.stringify([server, tool]))
    .digest("hex")
    .slice(0, 10)}_${tool.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 45)}`
}

export function resource(server: string, tool: string) {
  // Native Windows permission matching ignores case. Encode identities as bytes,
  // without wildcard characters or case-folding aliases; metadata preserves the names.
  return `${serverResource(server)}/${serverResource(tool)}`
}

export function serverResource(name: string) {
  if (!name.isWellFormed()) throw new TypeError("MCP identifiers must contain well-formed Unicode")
  return `~${Buffer.from(name, "utf8").toString("hex")}`
}

function validNames(names: readonly string[]) {
  return names.every((name) => name.length > 0 && name.isWellFormed())
    ? Effect.void
    : Effect.fail(
        new MCPError.Failure({
          kind: "catalog",
          message: "MCP identifiers must be nonempty, well-formed Unicode strings",
        }),
      )
}

function catalogMap(catalog: readonly MCPClient.Definition[]) {
  const result = new Map(catalog.map((tool) => [tool.name, tool]))
  return validNames(catalog.map((tool) => tool.name)).pipe(
    Effect.andThen(
      result.size === catalog.length
        ? Effect.succeed(result)
        : Effect.fail(new MCPError.Failure({ kind: "catalog", message: "MCP catalog contains duplicate tool names" })),
    ),
  )
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Config.node,
    PermissionV2.node,
    ToolRegistry.node,
    SessionStore.node,
    EventV2.node,
    Location.node,
    MCPOAuth.node,
  ],
})
