import { describe, expect, it } from "bun:test"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigMCP } from "@opencode-ai/core/config/mcp"
import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Integration } from "@opencode-ai/core/integration"
import { Location } from "@opencode-ai/core/location"
import { MCPV2 } from "@opencode-ai/core/mcp"
import { MCPOAuth } from "@opencode-ai/core/mcp/oauth"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { Effect, Layer, Schema, Scope } from "effect"
import { location } from "./fixture/location"

const directory = AbsolutePath.make(process.cwd())
const sessionID = SessionV2.ID.make("ses_mcp_oauth")
const agent = AgentV2.ID.make("build")
const allow = [{ action: "mcp.*", resource: "*", effect: "allow" }] satisfies PermissionV2.Ruleset
describe("MCP OAuth integration", () => {
  it("requires explicit OAuth, stores credentials privately, authorizes canonical calls, and invalidates revocation", async () => {
    const server = fixture()
    try {
      await run(
        { fixture: remoteConfig(server.url, { redirect_uri: "http://127.0.0.1:0/callback" }) },
        Effect.gen(function* () {
          yield* setup([sessionID], allow)
          const manager = yield* MCPV2.Service
          const registry = yield* ToolRegistry.Service
          const integrations = yield* Integration.Service
          const credentials = yield* Credential.Service
          const oauth = yield* MCPOAuth.Service
          const context = toolContext(sessionID)

          const initial = yield* Effect.result(manager.connect("fixture", context))
          expect(initial._tag).toBe("Failure")
          if (initial._tag === "Failure") expect(String(initial.failure)).toContain("authentication")
          expect(server.oauthRequests.filter((request) => request.path === "/register")).toHaveLength(0)
          expect(server.oauthRequests.filter((request) => request.path === "/token")).toHaveLength(0)
          const initialSummary = JSON.stringify(yield* manager.servers({ query: "fixture" }, context))
          const profile = oauth.profile("fixture")
          expect(profile).toBeDefined()
          if (!profile) throw new Error("Expected the configured MCP OAuth profile")
          expect(initialSummary).toContain(profile.integrationID)
          expect(oauth.bearer("fixture")).toBeUndefined()

          const attempt = yield* integrations.connection.oauth({
            integrationID: profile.integrationID,
            methodID: profile.methodID,
            inputs: {},
          })
          expect(attempt.mode).toBe("auto")
          expect(server.oauthRequests.filter((request) => request.path === "/register")).toHaveLength(1)
          expect(server.oauthRequests.filter((request) => request.path === "/token")).toHaveLength(0)
          const authorizationURL = new URL(attempt.url)
          const callbackURL = new URL(authorizationURL.searchParams.get("redirect_uri") ?? "")
          callbackURL.searchParams.set("code", "native-code")
          callbackURL.searchParams.set("state", authorizationURL.searchParams.get("state") ?? "")
          callbackURL.searchParams.set("iss", server.origin)
          const callbackResponse = yield* Effect.promise(() => fetch(callbackURL))
          expect(callbackResponse.status).toBe(200)

          const status = yield* awaitAttempt(integrations, attempt.attemptID)
          expect(status.status).toBe("complete")
          expect(server.oauthRequests.filter((request) => request.path === "/token")).toHaveLength(1)
          const saved = yield* credentials.list(profile.integrationID)
          expect(saved).toHaveLength(1)
          expect(saved[0]?.value.type).toBe("oauth")
          expect(JSON.stringify(yield* integrations.get(profile.integrationID))).not.toContain("native-access")
          expect(oauth.bearer("fixture")).toBeUndefined()

          const connected = yield* manager.connect("fixture", context)
          expect(connected.status).toBe("connected")
          expect(connected.authentication).toEqual(profile)
          expect(oauth.bearer("fixture")).toBe("native-access")
          expect(
            server.mcpRequests
              .filter((request) => request.path === "/mcp" && request.authorization !== null)
              .every((request) => request.authorization === "Bearer native-access"),
          ).toBe(true)
          expect(server.mcpRequests.some((request) => request.authorization === "Bearer native-access")).toBe(true)

          const exposed = yield* manager.expose("fixture", ["echo"], context)
          const name = exposureName(exposed)
          const materialized = yield* registry.materialize([], sessionID)
          expect(materialized.definitions.map((definition) => definition.name)).toContain(name)
          const successfulCall = yield* materialized.settle(toolCall(name, { value: "authorized" }, "call-authorized"))
          expect(successfulCall.result.type).not.toBe("error")
          expect(server.sideEffects).toBe(1)

          for (const status of [401, 403, 404]) {
            server.rejectCallStatus = status
            const failedCall = yield* materialized.settle(
              toolCall(name, { value: `side effect before ${status}` }, `call-${status}`),
            )
            expect(failedCall.result.type).toBe("error")
          }
          expect(server.sideEffects).toBe(4)
          expect(server.mcpRequests.filter((request) => request.rpcMethod === "tools/call")).toHaveLength(4)
          expect(server.oauthRequests.filter((request) => request.path === "/token")).toHaveLength(1)

          const integration = (yield* integrations.get(profile.integrationID))!
          const credentialID = integration.connections.find((connection) => connection.type === "credential")
          expect(credentialID?.type).toBe("credential")
          if (credentialID?.type !== "credential") return
          yield* integrations.connection.remove(credentialID.id)
          expect(yield* credentials.list(profile.integrationID)).toHaveLength(0)
          const afterRemoval = yield* materialized.settle(toolCall(name, { value: "must not run" }, "call-revoked"))
          expect(afterRemoval.result.type).toBe("error")
          expect(server.sideEffects).toBe(4)
          expect(oauth.bearer("fixture")).toBeUndefined()
          expect(
            (yield* registry.materialize([], sessionID)).definitions.map((definition) => definition.name),
          ).not.toContain(name)
        }),
      )
    } finally {
      await server.close()
    }
  })

  it("keeps configured Authorization headers ahead of cached OAuth credentials", async () => {
    const server = fixture({ expectedAuthorization: "Bearer explicit-token" })
    try {
      await run(
        {
          explicit: remoteConfig(
            server.url,
            { client_id: "unused-client" },
            { Authorization: "Bearer explicit-token" },
          ),
        },
        Effect.gen(function* () {
          yield* setup([sessionID], allow)
          const manager = yield* MCPV2.Service
          const oauth = yield* MCPOAuth.Service
          const credentials = yield* Credential.Service
          const profile = oauth.profile("explicit")
          if (!profile) throw new Error("Expected the configured MCP OAuth profile")
          yield* credentials.create({
            integrationID: profile.integrationID,
            value: Schema.decodeUnknownSync(Credential.OAuth)({
              type: "oauth",
              methodID: profile.methodID,
              access: "expired-access",
              refresh: "expired-refresh",
              expires: 1,
            }),
          })
          const summary = yield* manager.connect("explicit", toolContext(sessionID))
          expect(summary.status).toBe("connected")
          expect(summary.authentication).toEqual(profile)
          expect(oauth.bearer("explicit")).toBeUndefined()
          expect(server.oauthRequests.filter((request) => request.path === "/register")).toHaveLength(0)
          expect(server.oauthRequests.filter((request) => request.path === "/token")).toHaveLength(0)
          expect(server.mcpRequests.every((request) => request.authorization === "Bearer explicit-token")).toBe(true)
        }),
      )
    } finally {
      await server.close()
    }
  })

  it("derives stable profiles from location, server identity, and credential-relevant configuration", () => {
    const server = remoteConfig("http://127.0.0.1:1/mcp", { client_id: "one" }, { Z: "last", A: "first" })
    const reordered = remoteConfig("http://127.0.0.1:1/mcp", { client_id: "one" }, { A: "first", Z: "last" })
    const changedHeader = remoteConfig("http://127.0.0.1:1/mcp", { client_id: "one" }, { A: "different" })
    const one = location({ directory, workspaceID: undefined })
    const other = location({ directory: AbsolutePath.make(`${process.cwd()}-other`), workspaceID: undefined })

    expect(MCPOAuth.identity(one, "fixture", server)).toBe(MCPOAuth.identity(one, "fixture", reordered))
    expect(MCPOAuth.identity(one, "fixture", server)).not.toBe(MCPOAuth.identity(other, "fixture", server))
    expect(MCPOAuth.identity(one, "fixture", server)).not.toBe(MCPOAuth.identity(one, "other", server))
    expect(MCPOAuth.identity(one, "fixture", server)).not.toBe(MCPOAuth.identity(one, "fixture", changedHeader))
  })
})

function runtime(servers: Record<string, typeof ConfigMCP.Server.Type>) {
  const config = Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.succeed([
          new Config.Document({
            type: "document",
            info: new Config.Info({ mcp: new ConfigMCP.Info({ servers }) }),
          }),
        ]),
    }),
  )
  const current = Layer.succeed(Location.Service, Location.Service.of(location({ directory })))
  return AppNodeBuilder.build(
    LayerNode.group([
      MCPV2.node,
      MCPOAuth.node,
      Integration.node,
      Credential.node,
      ToolRegistry.node,
      AgentV2.node,
      Database.node,
      EventV2.node,
      PermissionV2.node,
    ]),
    [
      [Config.node, config],
      [Location.node, current],
      [Database.node, Database.layerFromPath(":memory:")],
    ],
  )
}

function run<A, E>(
  servers: Record<string, typeof ConfigMCP.Server.Type>,
  program: Effect.Effect<
    A,
    E,
    | Database.Service
    | AgentV2.Service
    | MCPV2.Service
    | ToolRegistry.Service
    | EventV2.Service
    | PermissionV2.Service
    | Integration.Service
    | Credential.Service
    | MCPOAuth.Service
    | Scope.Scope
  >,
) {
  return Effect.runPromise(Effect.scoped(Effect.provide(program, runtime(servers))))
}

function setup(sessionIDs: readonly SessionV2.ID[], rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      sessionIDs,
      (id) =>
        db
          .insert(SessionTable)
          .values({
            id,
            project_id: Project.ID.global,
            slug: id,
            directory,
            title: id,
            version: "test",
            agent: "build",
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie),
      { discard: true },
    )
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) => editor.update(agent, (value) => (value.permissions = [...rules])))
  })
}

function toolContext(sessionID: SessionV2.ID) {
  return {
    sessionID,
    agent,
    assistantMessageID: SessionMessage.ID.make("msg_mcp_oauth"),
    toolCallID: "call_mcp_oauth",
  }
}

function toolCall(name: string, input: Record<string, unknown>, id: string) {
  return {
    sessionID,
    agent,
    assistantMessageID: SessionMessage.ID.make("msg_mcp_oauth_settlement"),
    call: { type: "tool-call" as const, id, name, input },
  }
}

function remoteConfig(url: string, oauth: Partial<ConfigMCP.OAuth> | false, headers?: Record<string, string>) {
  return new ConfigMCP.Remote({
    type: "remote",
    url,
    headers,
    oauth: oauth === false ? false : new ConfigMCP.OAuth(oauth),
  })
}

function exposureName(value: unknown) {
  return Schema.decodeUnknownSync(Schema.Struct({ tools: Schema.Array(Schema.Struct({ name: Schema.String })) }))(value)
    .tools[0]!.name
}

function awaitAttempt(integrations: Integration.Interface, attemptID: Integration.AttemptID) {
  return Effect.gen(function* () {
    for (let poll = 0; poll < 150; poll++) {
      const status = yield* integrations.attempt.status(attemptID)
      if (status.status !== "pending") return status
      yield* Effect.sleep("20 millis")
    }
    return yield* Effect.fail(new Error("OAuth attempt did not complete"))
  })
}

type RpcRequest = {
  readonly id?: number | string
  readonly method: string
  readonly params?: { readonly name?: string; readonly arguments?: Record<string, unknown> }
}

function fixture(options: { readonly expectedAuthorization?: string } = {}) {
  const originHolder = { value: "" }
  const mcpRequests: Array<{ path: string; method?: string; rpcMethod?: string; authorization?: string | null }> = []
  const oauthRequests: Array<{ path: string; method: string; headers: Headers; body?: string }> = []
  let sideEffects = 0
  let rejectCallStatus: number | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/mcp") {
        const body = request.method === "POST" ? await request.text() : undefined
        oauthRequests.push({ path: url.pathname, method: request.method, headers: new Headers(request.headers), body })
        if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
          return Response.json({
            resource: `${originHolder.value}/mcp`,
            authorization_servers: [originHolder.value],
            scopes_supported: ["mcp"],
          })
        }
        if (url.pathname === "/.well-known/oauth-authorization-server") {
          return Response.json({
            issuer: originHolder.value,
            authorization_endpoint: `${originHolder.value}/authorize`,
            token_endpoint: `${originHolder.value}/token`,
            registration_endpoint: `${originHolder.value}/register`,
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            token_endpoint_auth_methods_supported: ["none"],
            code_challenge_methods_supported: ["S256"],
            authorization_response_iss_parameter_supported: true,
          })
        }
        if (url.pathname === "/register") {
          const input = JSON.parse(body ?? "{}") as Record<string, unknown>
          return Response.json({ ...input, client_id: "native-client" }, { status: 201 })
        }
        if (url.pathname === "/token") {
          return Response.json({
            access_token: "native-access",
            refresh_token: "native-refresh",
            token_type: "Bearer",
          })
        }
        return new Response("Not found", { status: 404 })
      }

      const authorization = request.headers.get("authorization")
      mcpRequests.push({ path: url.pathname, method: request.method, authorization })
      if (request.method === "GET") {
        if (authorization === (options.expectedAuthorization ?? "Bearer native-access"))
          return new Response(null, { status: 405 })
        return unauthorized(originHolder.value)
      }
      if (authorization !== (options.expectedAuthorization ?? "Bearer native-access"))
        return unauthorized(originHolder.value)
      const message = (await request.json()) as RpcRequest
      const recorded = mcpRequests[mcpRequests.length - 1]
      if (recorded) recorded.rpcMethod = message.method
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (message.method === "initialize")
        return rpc(
          message,
          {
            protocolVersion: "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "native-oauth", version: "1.0.0" },
          },
          true,
        )
      if (message.method === "tools/list")
        return rpc(
          message,
          {
            tools: [
              {
                name: "echo",
                description: "Echo from authenticated MCP",
                inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
              },
            ],
          },
          true,
        )
      if (message.method === "tools/call") {
        sideEffects++
        if (rejectCallStatus !== undefined)
          return new Response("Rejected after side effect", { status: rejectCallStatus })
        return rpc(
          message,
          {
            content: [{ type: "text", text: "Echo result" }],
            structuredContent: { value: message.params?.arguments?.value },
          },
          true,
        )
      }
      return new Response(null, { status: 202 })
    },
  })
  originHolder.value = `http://127.0.0.1:${server.port}`
  return {
    url: `${originHolder.value}/mcp`,
    origin: originHolder.value,
    mcpRequests,
    oauthRequests,
    get sideEffects() {
      return sideEffects
    },
    set rejectCallStatus(value: number | undefined) {
      rejectCallStatus = value
    },
    close: () => server.stop(true),
  }
}

function unauthorized(origin: string) {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
    },
  })
}

function rpc(message: RpcRequest, result: unknown, session = false) {
  return Response.json(
    { jsonrpc: "2.0", id: message.id, result },
    { headers: session ? { "mcp-session-id": "native-mcp-session" } : undefined },
  )
}
