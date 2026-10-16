export * as MCPOAuth from "./oauth"

import { createHash } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "../config"
import { Credential } from "../credential"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Integration } from "../integration"
import { Location } from "../location"
import { OAuthLoopback } from "../oauth/loopback"
import { MCPConfig } from "./config"
import { MCPError } from "./error"
import { MCPOAuthFlow } from "./oauth-flow"

export type Profile = { readonly integrationID: Integration.ID; readonly methodID: Integration.MethodID }

export interface Interface {
  readonly profile: (name: string) => Profile | undefined
  readonly prepare: (name: string) => Effect.Effect<void, MCPError.Failure>
  readonly bearer: (name: string) => string | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/MCPOAuth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const location = yield* Location.Service
    const integrations = yield* Integration.Service
    const credentials = yield* Credential.Service
    const callbacks = yield* OAuthLoopback.Service
    const events = yield* EventV2.Service
    const configured = MCPConfig.resolve(yield* config.entries())
    const profiles = new Map(
      [...configured.servers].flatMap(([name, server]) => {
        if (server.type !== "remote" || server.oauth === false) return []
        const integrationID = identity(location, name, server)
        return [
          [
            name,
            {
              integrationID,
              methodID: Integration.MethodID.make("oauth"),
              server,
              timeout: server.timeout?.request ?? configured.timeout.request,
            },
          ] as const,
        ]
      }),
    )
    const tokens = new Map<string, string>()
    const revisions = new Map<string, number>()
    const previouslyAuthorized = new Set<string>()

    yield* integrations.transform((editor) => {
      for (const [name, binding] of profiles) {
        editor.update(binding.integrationID, (entry) => {
          entry.name = `MCP: ${name}`
        })
        editor.method.update({
          integrationID: binding.integrationID,
          method: { id: binding.methodID, type: "oauth", label: "Authorize MCP server" },
          authorize: () =>
            Effect.gen(function* () {
              const previous = (yield* credentials.list(binding.integrationID)).find(
                (credential) => credential.value.type === "oauth",
              )?.value
              return yield* MCPOAuthFlow.authorize(
                binding,
                callbacks,
                previous?.type === "oauth" ? previous : undefined,
              )
            }),
          refresh: (value) => MCPOAuthFlow.refresh(binding, value),
        })
      }
    })
    // ConnectionUpdated is transient; durable projectors never receive it.
    yield* Effect.acquireRelease(
      events.listen((event) =>
        Effect.sync(() => {
          if (event.type !== Integration.Event.ConnectionUpdated.type) return
          const data = Schema.decodeUnknownSync(Integration.Event.ConnectionUpdated.data)(event.data)
          for (const [name, binding] of profiles) {
            if (binding.integrationID !== data.integrationID) continue
            tokens.delete(name)
            revisions.set(name, (revisions.get(name) ?? 0) + 1)
          }
        }),
      ),
      (unsubscribe) => unsubscribe,
    )

    return Service.of({
      profile: (name) => {
        const binding = profiles.get(name)
        return binding ? { integrationID: binding.integrationID, methodID: binding.methodID } : undefined
      },
      bearer: (name) => tokens.get(name),
      prepare: (name) =>
        Effect.gen(function* () {
          const binding = profiles.get(name)
          if (!binding || new Headers(binding.server.headers).has("authorization")) return
          const revision = revisions.get(name) ?? 0
          const connection = yield* integrations.connection.active(binding.integrationID)
          if ((revisions.get(name) ?? 0) !== revision)
            return yield* new MCPError.Failure({
              kind: "authentication_required",
              message: "MCP OAuth connection changed during preparation; connect again explicitly",
            })
          if (!connection) {
            tokens.delete(name)
            if (previouslyAuthorized.has(name))
              return yield* new MCPError.Failure({
                kind: "authentication_required",
                message: "MCP OAuth credentials were removed; authorize again before calling tools",
              })
            return
          }
          const value = yield* integrations.connection.resolve(connection).pipe(
            Effect.tapError(() => Effect.sync(() => tokens.delete(name))),
            Effect.mapError(
              () =>
                new MCPError.Failure({
                  kind: "authentication_required",
                  message: "MCP OAuth must be authorized again through its integration",
                }),
            ),
          )
          if ((revisions.get(name) ?? 0) !== revision)
            return yield* new MCPError.Failure({
              kind: "authentication_required",
              message: "MCP OAuth connection changed during preparation; connect again explicitly",
            })
          if (!value || value.type !== "oauth" || !MCPOAuthFlow.readStored(value, binding)) {
            tokens.delete(name)
            return yield* new MCPError.Failure({
              kind: "authentication_required",
              message: "MCP OAuth credentials do not match this server configuration",
            })
          }
          tokens.set(name, value.access)
          previouslyAuthorized.add(name)
        }),
    })
  }),
)

/** Identity includes the Location and credential-relevant config, with stable key ordering. */
export function identity(
  location: Pick<Location.Interface, "directory" | "workspaceID">,
  name: string,
  server: MCPConfig.Server,
) {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : value
  return Integration.ID.make(
    `mcp:${createHash("sha256")
      .update(
        JSON.stringify(
          canonical({
            directory: location.directory,
            workspaceID: location.workspaceID,
            name,
            server:
              server.type === "remote" ? { url: server.url, headers: server.headers, oauth: server.oauth } : server,
          }),
        ),
      )
      .digest("hex")}`,
  )
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, Location.node, Integration.node, Credential.node, OAuthLoopback.node, EventV2.node],
})
