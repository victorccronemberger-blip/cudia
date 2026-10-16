import { createHash } from "node:crypto"
import { createServer } from "node:net"
import { describe, expect } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import type { Scope } from "effect"
import { Credential } from "@opencode-ai/core/credential"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Integration } from "@opencode-ai/core/integration"
import { MCPOAuthFlow } from "@opencode-ai/core/mcp/oauth-flow"
import { OAuthLoopback } from "@opencode-ai/core/oauth/loopback"
import { ConfigMCP } from "@opencode-ai/core/config/mcp"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(OAuthLoopback.node))

type AuthRequest = {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body?: string
}

describe("MCPOAuthFlow", () => {
  it.live("uses PKCE and the discovered resource, binds callback state/issuer, and consumes the callback once", () =>
    Effect.gen(function* () {
      const auth = yield* Effect.acquireRelease(
        Effect.sync(() => startAuthorizationServer({ issuerRequired: true, issueRefresh: false })),
        (server) => Effect.promise(server.close),
      )
      const resource = yield* Effect.acquireRelease(
        Effect.sync(() => startResourceServer(auth.url)),
        (server) => Effect.promise(server.close),
      )
      const callbacks = yield* OAuthLoopback.Service
      const binding = makeBinding(
        resource.url,
        {
          client_id: "configured-client",
          redirect_uri: "http://127.0.0.1:0/callback",
        },
        { Authorization: "Bearer resource-secret", "X-Workspace-Secret": "private-value" },
      )
      const authorization = yield* MCPOAuthFlow.authorize(binding, callbacks)
      const authorizationURL = new URL(authorization.url)
      const callbackURI = authorizationURL.searchParams.get("redirect_uri")
      const state = authorizationURL.searchParams.get("state")
      const resourceURL = `${resource.url}/mcp`
      const clientChallenge = authorizationURL.searchParams.get("code_challenge")
      const sentinel = yield* callbacks.listen({ redirectURL: callbackURI ?? "", state: "sentinel-state" })

      expect(authorizationURL.searchParams.get("client_id")).toBe("configured-client")
      expect(authorizationURL.searchParams.get("code_challenge_method")).toBe("S256")
      expect(clientChallenge).toBeTruthy()
      expect(authorizationURL.searchParams.get("resource")).toBe(resourceURL)
      expect(callbackURI).toBe(sentinel.url)
      expect(state).toBeTruthy()

      const invalidState = yield* Effect.promise(() => fetch(`${callbackURI}?state=wrong&code=valid-code`))
      expect(invalidState.status).toBe(400)
      const callbackFiber = yield* Effect.exit(callbackEffect(authorization)).pipe(Effect.forkScoped)
      const callback = new URL(callbackURI ?? "")
      callback.searchParams.set("code", "valid-code")
      callback.searchParams.set("state", state ?? "")
      callback.searchParams.set("iss", auth.url)
      const response = yield* Effect.promise(() => fetch(callback))
      expect(response.status).toBe(200)
      expect(yield* Effect.promise(() => response.text())).toBe(
        "Authorization received. Return to CUDIA to check status.",
      )

      const result = yield* Fiber.join(callbackFiber)
      expect(Exit.isSuccess(result)).toBe(true)
      if (!Exit.isSuccess(result)) return
      expect(result.value.access).toBe("access-valid-code")
      expect(result.value.refresh).toBeUndefined()
      expect(result.value.expires).toBeUndefined()
      expect(result.value.issued).toBeGreaterThan(0)

      const repeated = yield* Effect.promise(() => fetch(callback))
      expect(repeated.status).toBe(400)
      expect(auth.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1)
      const tokenBody = new URLSearchParams(auth.requests.find((request) => request.url.endsWith("/token"))?.body)
      expect(tokenBody.get("resource")).toBe(resourceURL)
      expect(tokenBody.get("redirect_uri")).toBe(sentinel.url)
      expect(tokenBody.get("client_id")).toBe("configured-client")
      expect(tokenBody.get("code_verifier")).toBeTruthy()
      expect(
        createHash("sha256")
          .update(tokenBody.get("code_verifier") ?? "")
          .digest("base64url"),
      ).toBe(clientChallenge ?? "")
      expect(auth.requests.every((request) => request.headers.get("authorization") !== "Bearer resource-secret")).toBe(
        true,
      )
      expect(auth.requests.every((request) => request.headers.get("x-workspace-secret") !== "private-value")).toBe(true)
      expect(
        resource.requests.every((request) => request.headers.get("authorization") !== "Bearer resource-secret"),
      ).toBe(true)
      expect(resource.requests.every((request) => request.headers.get("x-workspace-secret") !== "private-value")).toBe(
        true,
      )
    }),
  )

  it.live(
    "preserves RFC 9207 issuer requirements from OIDC fallback and rejects invalid callback parameters before token POST",
    () =>
      Effect.gen(function* () {
        const auth = yield* Effect.acquireRelease(
          Effect.sync(() => startAuthorizationServer({ issuerRequired: true, oidcOnly: true })),
          (server) => Effect.promise(server.close),
        )
        const resource = yield* Effect.acquireRelease(
          Effect.sync(() => startResourceServer(auth.url)),
          (server) => Effect.promise(server.close),
        )
        const callbacks = yield* OAuthLoopback.Service
        const binding = makeBinding(resource.url, {
          client_id: "configured-client",
          redirect_uri: "http://127.0.0.1:0/callback",
        })

        const callbackCases: Array<{ code: string; duplicateCode?: string; iss?: string }> = [
          { code: "valid-code" },
          { code: "valid-code", iss: "http://127.0.0.1:1" },
          { code: "one", duplicateCode: "two", iss: auth.url },
        ]
        for (const callbackParams of callbackCases) {
          const authorization = yield* MCPOAuthFlow.authorize(binding, callbacks)
          const authorizationURL = new URL(authorization.url)
          const callbackURI = authorizationURL.searchParams.get("redirect_uri") ?? ""
          const callbackFiber = yield* Effect.exit(callbackEffect(authorization)).pipe(Effect.forkScoped)
          const callback = new URL(callbackURI)
          callback.searchParams.set("state", authorizationURL.searchParams.get("state") ?? "")
          callback.searchParams.set("code", callbackParams.code)
          if (callbackParams.duplicateCode) callback.searchParams.append("code", callbackParams.duplicateCode)
          if (callbackParams.iss) callback.searchParams.set("iss", callbackParams.iss)
          const response = yield* Effect.promise(() => fetch(callback))
          expect(response.status).toBe(200)
          expect(Exit.isFailure(yield* Fiber.join(callbackFiber))).toBe(true)
        }

        expect(auth.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(0)
        expect(auth.requests.some((request) => request.url.endsWith("/.well-known/openid-configuration"))).toBe(true)
      }),
  )

  it.live(
    "reuses dynamic registration only for the same issuer and redirect, and preserves a rotating refresh token",
    () =>
      Effect.gen(function* () {
        const authA = yield* Effect.acquireRelease(
          Effect.sync(() => startAuthorizationServer()),
          (server) => Effect.promise(server.close),
        )
        const authB = yield* Effect.acquireRelease(
          Effect.sync(() => startAuthorizationServer()),
          (server) => Effect.promise(server.close),
        )
        const resource = yield* Effect.acquireRelease(
          Effect.sync(() => startResourceServer(authA.url)),
          (server) => Effect.promise(server.close),
        )
        const callbackPort = yield* Effect.promise(findFreePort)
        const callbacks = yield* OAuthLoopback.Service
        const binding = makeBinding(resource.url, { callback_port: callbackPort })

        const first = yield* MCPOAuthFlow.authorize(binding, callbacks)
        const firstClient = new URL(first.url).searchParams.get("client_id")
        expect(authA.registrations).toHaveLength(1)
        const firstCredential = yield* completeAuthorization(first, authA.url)
        expect(firstCredential.refresh).toBe("refresh-original")

        const second = yield* MCPOAuthFlow.authorize(binding, callbacks, firstCredential)
        expect(new URL(second.url).searchParams.get("client_id")).toBe(firstClient)
        expect(authA.registrations).toHaveLength(1)
        const secondCredential = yield* completeAuthorization(second, authA.url)

        const refreshed = yield* MCPOAuthFlow.refresh(binding, secondCredential)
        expect(refreshed.access).toBe("access-refreshed")
        expect(refreshed.refresh).toBe("refresh-original")

        const otherRedirect = makeBinding(resource.url, { callback_port: yield* Effect.promise(findFreePort) })
        const fourth = yield* MCPOAuthFlow.authorize(otherRedirect, callbacks, secondCredential)
        expect(authA.registrations).toHaveLength(2)
        yield* completeAuthorization(fourth, authA.url)

        resource.setIssuer(authB.url)
        const third = yield* MCPOAuthFlow.authorize(binding, callbacks, secondCredential)
        expect(new URL(third.url).searchParams.get("client_id")).toBeTruthy()
        expect(authB.registrations).toHaveLength(1)
        yield* completeAuthorization(third, authB.url)
        expect(authA.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(4)
      }),
  )

  it.live("rejects authorization-server issuer mismatches before registration or token exchange", () =>
    Effect.gen(function* () {
      const auth = yield* Effect.acquireRelease(
        Effect.sync(() => startAuthorizationServer({ metadataIssuer: "http://127.0.0.1:1" })),
        (server) => Effect.promise(server.close),
      )
      const resource = yield* Effect.acquireRelease(
        Effect.sync(() => startResourceServer(auth.url)),
        (server) => Effect.promise(server.close),
      )
      const callbacks = yield* OAuthLoopback.Service
      const binding = makeBinding(resource.url, {})
      const result = yield* Effect.exit(MCPOAuthFlow.authorize(binding, callbacks))

      expect(Exit.isFailure(result)).toBe(true)
      expect(auth.registrations).toHaveLength(0)
      expect(auth.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(0)
    }),
  )

  it.live("aborts a delayed token request at the configured timeout without retrying", () =>
    Effect.gen(function* () {
      const auth = yield* Effect.acquireRelease(
        Effect.sync(() => startAuthorizationServer({ tokenDelay: 250 })),
        (server) => Effect.promise(server.close),
      )
      const resource = yield* Effect.acquireRelease(
        Effect.sync(() => startResourceServer(auth.url)),
        (server) => Effect.promise(server.close),
      )
      const callbacks = yield* OAuthLoopback.Service
      const binding = makeBinding(
        resource.url,
        { client_id: "configured-client", redirect_uri: "http://127.0.0.1:0/callback" },
        undefined,
        80,
      )
      const authorization = yield* MCPOAuthFlow.authorize(binding, callbacks)
      const authorizationURL = new URL(authorization.url)
      const callbackFiber = yield* Effect.exit(callbackEffect(authorization)).pipe(Effect.forkScoped)
      const callback = new URL(authorizationURL.searchParams.get("redirect_uri") ?? "")
      callback.searchParams.set("code", "valid-code")
      callback.searchParams.set("state", authorizationURL.searchParams.get("state") ?? "")
      callback.searchParams.set("iss", auth.url)
      expect((yield* Effect.promise(() => fetch(callback))).status).toBe(200)
      expect(Exit.isFailure(yield* Fiber.join(callbackFiber))).toBe(true)
      expect(auth.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1)
    }),
  )

  it.live("does not follow registration or token redirects with credentials", () =>
    Effect.gen(function* () {
      const received: string[] = []
      const destination = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(request) {
              received.push(await request.text())
              return Response.json({ error: "redirected-secret" })
            },
          }),
        ),
        (server) => Effect.promise(() => server.stop(true)),
      )
      const callbacks = yield* OAuthLoopback.Service
      for (const operation of ["registration", "token"] as const) {
        const redirect = () =>
          new Response("redirected-secret", {
            status: 307,
            headers: { location: `http://127.0.0.1:${destination.port}/capture` },
          })
        const auth = yield* Effect.acquireRelease(
          Effect.sync(() =>
            startAuthorizationServer({
              ...(operation === "registration" ? { registrationResponse: redirect } : { tokenResponse: redirect }),
            }),
          ),
          (server) => Effect.promise(server.close),
        )
        const resource = yield* Effect.acquireRelease(
          Effect.sync(() => startResourceServer(auth.url)),
          (server) => Effect.promise(server.close),
        )
        const binding = makeBinding(resource.url, { redirect_uri: "http://127.0.0.1:0/callback" })
        const result = yield* Effect.exit(
          Effect.gen(function* () {
            const authorization = yield* MCPOAuthFlow.authorize(binding, callbacks)
            return yield* submitCallback(authorization, auth.url)
          }),
        )
        expect(Exit.isFailure(result)).toBe(true)
        expect(JSON.stringify(result)).not.toContain("redirected-secret")
        expect(auth.registrations).toHaveLength(1)
        expect(auth.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(
          operation === "token" ? 1 : 0,
        )
      }
      expect(received).toHaveLength(0)
    }),
  )

  it.live("bounds streamed token responses and keeps remote error bodies out of diagnostics", () =>
    Effect.gen(function* () {
      const auth = yield* Effect.acquireRelease(
        Effect.sync(() =>
          startAuthorizationServer({
            tokenResponse: () =>
              new Response(
                new ReadableStream({
                  start(controller) {
                    for (let index = 0; index < 9; index++)
                      controller.enqueue(new TextEncoder().encode("remote-secret".repeat(6000)))
                    controller.close()
                  },
                }),
                { headers: { "content-type": "application/json" } },
              ),
          }),
        ),
        (server) => Effect.promise(server.close),
      )
      const resource = yield* Effect.acquireRelease(
        Effect.sync(() => startResourceServer(auth.url)),
        (server) => Effect.promise(server.close),
      )
      const callbacks = yield* OAuthLoopback.Service
      const authorization = yield* MCPOAuthFlow.authorize(
        makeBinding(resource.url, { client_id: "client", redirect_uri: "http://127.0.0.1:0/callback" }),
        callbacks,
      )
      const result = yield* Effect.exit(submitCallback(authorization, auth.url))
      expect(Exit.isFailure(result)).toBe(true)
      expect(JSON.stringify(result)).not.toContain("remote-secret")
      expect(JSON.stringify(result).length).toBeLessThan(4000)
      expect(auth.requests.filter((request) => request.url.endsWith("/token"))).toHaveLength(1)
    }),
  )
})

function makeBinding(
  url: string,
  oauth: Partial<ConfigMCP.OAuth>,
  headers?: Record<string, string>,
  timeout = 2000,
): MCPOAuthFlow.Binding {
  return {
    integrationID: Integration.ID.make("oauth-flow-test"),
    methodID: Integration.MethodID.make("mcp"),
    server: new ConfigMCP.Remote({
      type: "remote",
      url: new URL("/mcp", url).toString(),
      headers,
      oauth: new ConfigMCP.OAuth(oauth),
    }),
    timeout,
  }
}

function startAuthorizationServer(
  options: {
    readonly issuerRequired?: boolean
    readonly oidcOnly?: boolean
    readonly metadataIssuer?: string
    readonly tokenDelay?: number
    readonly issueRefresh?: boolean
    readonly registrationResponse?: () => Response
    readonly tokenResponse?: () => Response
  } = {},
) {
  const requests: AuthRequest[] = []
  const registrations: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.text() : undefined
      requests.push({
        url: `${url.origin}${url.pathname}`,
        method: request.method,
        headers: new Headers(request.headers),
        body,
      })

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        if (options.oidcOnly) return new Response("Not found", { status: 404 })
        return Response.json(metadata(url.origin, options))
      }
      if (url.pathname === "/.well-known/openid-configuration") return Response.json(metadata(url.origin, options))
      if (url.pathname === "/register") {
        const input = JSON.parse(body ?? "{}") as Record<string, unknown>
        registrations.push(input)
        if (options.registrationResponse) return options.registrationResponse()
        return Response.json({ ...input, client_id: `dynamic-client-${registrations.length}` }, { status: 201 })
      }
      if (url.pathname === "/token") {
        if (options.tokenResponse) return options.tokenResponse()
        if (options.tokenDelay) await new Promise((resolve) => setTimeout(resolve, options.tokenDelay))
        const form = new URLSearchParams(body)
        if (form.get("grant_type") === "refresh_token") {
          return Response.json({ access_token: "access-refreshed", token_type: "Bearer" })
        }
        return Response.json({
          access_token: `access-${form.get("code")}`,
          token_type: "Bearer",
          ...(options.issueRefresh === false ? {} : { refresh_token: "refresh-original" }),
        })
      }
      return new Response("Not found", { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    registrations,
    close: () => server.stop(true),
  }
}

function metadata(origin: string, options: { readonly issuerRequired?: boolean; readonly metadataIssuer?: string }) {
  return {
    issuer: options.metadataIssuer ?? origin,
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    registration_endpoint: `${origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    ...(options.issuerRequired ? { authorization_response_iss_parameter_supported: true } : {}),
  }
}

function startResourceServer(initialIssuer: string) {
  let issuer = initialIssuer
  const requests: AuthRequest[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      requests.push({
        url: `${url.origin}${url.pathname}`,
        method: request.method,
        headers: new Headers(request.headers),
      })
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${url.origin}/mcp`,
          authorization_servers: [issuer],
          scopes_supported: ["mcp"],
        })
      }
      if (url.pathname === "/mcp") {
        return new Response("Unauthorized", {
          status: 401,
          headers: {
            "WWW-Authenticate": `Bearer resource_metadata="${url.origin}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
          },
        })
      }
      return new Response("Not found", { status: 404 })
    },
  })

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    setIssuer: (value: string) => (issuer = value),
    close: () => server.stop(true),
  }
}

function completeAuthorization(
  authorization: Integration.OAuthAuthorization,
  issuer: string,
): Effect.Effect<Credential.OAuth, never, Scope.Scope> {
  return Effect.gen(function* () {
    const authorizationURL = new URL(authorization.url)
    const callback = new URL(authorizationURL.searchParams.get("redirect_uri") ?? "")
    callback.searchParams.set("code", "valid-code")
    callback.searchParams.set("state", authorizationURL.searchParams.get("state") ?? "")
    callback.searchParams.set("iss", issuer)
    const fiber = yield* Effect.exit(callbackEffect(authorization)).pipe(Effect.forkScoped)
    const response = yield* Effect.promise(() => fetch(callback))
    expect(response.status).toBe(200)
    const result = yield* Fiber.join(fiber)
    if (Exit.isFailure(result)) throw new Error("OAuth callback did not produce a credential")
    return result.value
  })
}

function callbackEffect(authorization: Integration.OAuthAuthorization) {
  if (typeof authorization.callback === "function") throw new Error("Expected an automatic OAuth callback")
  return authorization.callback
}

function submitCallback(authorization: Integration.OAuthAuthorization, issuer: string) {
  return Effect.gen(function* () {
    const authorizationURL = new URL(authorization.url)
    const callback = new URL(authorizationURL.searchParams.get("redirect_uri") ?? "")
    callback.searchParams.set("code", "private-code")
    callback.searchParams.set("state", authorizationURL.searchParams.get("state") ?? "")
    callback.searchParams.set("iss", issuer)
    const fiber = yield* callbackEffect(authorization).pipe(Effect.forkScoped)
    expect((yield* Effect.promise(() => fetch(callback))).status).toBe(200)
    return yield* Fiber.join(fiber)
  })
}

function findFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen({ host: "127.0.0.1", port: 0 }, () => {
      const address = server.address()
      if (!address || typeof address === "string") return reject(new Error("Could not reserve a callback port"))
      server.close((error) => (error ? reject(error) : resolve(address.port)))
    })
  })
}
