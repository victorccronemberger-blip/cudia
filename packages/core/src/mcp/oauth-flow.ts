export * as MCPOAuthFlow from "./oauth-flow"

import { Effect, Schema } from "effect"
import type { Scope } from "effect"
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js"
import { Credential } from "../credential"
import { Integration } from "../integration"
import { OAuthLoopback } from "../oauth/loopback"
import type { ConfigMCP } from "../config/mcp"

export type Binding = {
  readonly integrationID: Integration.ID
  readonly methodID: Integration.MethodID
  readonly server: ConfigMCP.Remote
  readonly timeout: number
}

const Stored = Schema.Struct({
  version: Schema.Literal(1),
  binding: Schema.String,
  issuer: Schema.String,
  resource: Schema.String,
  redirect: Schema.String,
  client: Schema.Record(Schema.String, Schema.Unknown),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
})

/** Only bounded local descriptions cross Integration's public attempt-status boundary. */
export class Failure extends Error {}

export function authorize(
  binding: Binding,
  callbacks: OAuthLoopback.Interface,
  previous?: Credential.OAuth,
): Effect.Effect<Integration.OAuthAuthorization, Failure, Scope.Scope> {
  return Effect.gen(function* () {
    const state = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")
    const configured = typeof binding.server.oauth === "object" ? binding.server.oauth : undefined
    const lease = yield* callbacks
      .listen({
        redirectURL:
          configured?.redirect_uri ?? `http://127.0.0.1:${configured?.callback_port ?? 19876}/mcp/oauth/callback`,
        state,
      })
      .pipe(Effect.mapError(() => new Failure("MCP OAuth loopback callback is unavailable")))

    const pending = yield* Effect.tryPromise({
      try: async (signal) => {
        const [sdk, schemas, utils] = await Promise.all([
          import("@modelcontextprotocol/sdk/client/auth.js"),
          import("@modelcontextprotocol/sdk/shared/auth.js"),
          import("@modelcontextprotocol/sdk/shared/auth-utils.js"),
        ])
        const server = endpoint(binding.server.url)
        const fetchFn = oauthFetch(signal, () => true)
        // Read only challenge headers; MCP request headers never enter OAuth discovery.
        const probe = await fetch(server, { method: "GET", signal, redirect: "manual" })
        const challenge = sdk.extractWWWAuthenticateParams(probe)
        await probe.body?.cancel()
        const resourceMetadata = await sdk.discoverOAuthProtectedResourceMetadata(
          server,
          {
            resourceMetadataUrl: challenge.resourceMetadataUrl,
          },
          fetchFn,
        )
        const issuer = resourceMetadata.authorization_servers?.[0]
        if (!issuer) throw new Failure("MCP OAuth discovery metadata is unavailable")
        const metadata = await discoverIssuer(issuer, fetchFn)
        const resource = endpoint(resourceMetadata.resource)
        if (!utils.checkResourceAllowed({ requestedResource: server, configuredResource: resource }))
          throw new Failure("MCP OAuth resource does not match this server")

        const allowed = oauthFetch(
          signal,
          (url, method) =>
            method === "GET" ||
            url.href === endpoint(metadata.token_endpoint).href ||
            (metadata.registration_endpoint !== undefined &&
              url.href === endpoint(metadata.registration_endpoint).href),
        )
        const client = await (async (): Promise<OAuthClientInformationMixed> => {
          const saved = previous ? readStored(previous, binding) : undefined
          if (configured?.client_secret && saved && saved.issuer !== metadata.issuer)
            throw new Failure(
              "MCP OAuth authorization server changed; review the client configuration before authorizing",
            )
          if (configured?.client_id) return { client_id: configured.client_id, client_secret: configured.client_secret }
          if (saved && saved.issuer === metadata.issuer && saved.redirect === lease.url) {
            const cached = schemas.OAuthClientInformationSchema.parse(saved.client)
            if (!cached.client_secret_expires_at || cached.client_secret_expires_at > Date.now() / 1000) return cached
          }
          const metadataURL = configured?.client_metadata_url
          if (typeof metadataURL === "string" && metadata.client_id_metadata_document_supported === true) {
            if (!sdk.isHttpsUrl(metadataURL))
              throw new Failure("MCP OAuth client metadata URL must be HTTPS with a document path")
            return { client_id: metadataURL }
          }
          if (!metadata.registration_endpoint)
            throw new Failure("MCP OAuth requires a configured client ID or advertised client registration")
          return sdk.registerClient(issuer, {
            metadata,
            clientMetadata: {
              client_name: "CUDIA",
              redirect_uris: [lease.url],
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
              token_endpoint_auth_method: "none",
            },
            scope: challenge.scope ?? configured?.scope,
            fetchFn: allowed,
          })
        })()
        const started = await sdk.startAuthorization(issuer, {
          metadata,
          clientInformation: client,
          redirectUrl: lease.url,
          scope: sdk.determineScope({
            requestedScope: challenge.scope ?? configured?.scope,
            resourceMetadata,
            authServerMetadata: metadata,
            clientMetadata: { redirect_uris: [lease.url], grant_types: ["authorization_code", "refresh_token"] },
          }),
          state,
          resource,
        })
        signal.throwIfAborted()
        return {
          url: started.authorizationUrl.href,
          verifier: started.codeVerifier,
          saved: Stored.make({
            version: 1,
            binding: binding.integrationID,
            issuer: metadata.issuer,
            resource: resource.href,
            redirect: lease.url,
            client: { ...client },
            metadata: { ...metadata },
          }),
          issuerRequired: metadata.authorization_response_iss_parameter_supported === true,
        }
      },
      catch: bounded,
    }).pipe(
      Effect.timeoutOrElse({
        duration: binding.timeout,
        orElse: () => Effect.fail(new Failure("MCP OAuth discovery timed out")),
      }),
    )

    return {
      mode: "auto" as const,
      url: pending.url,
      instructions: "Open this URL to authorize the configured MCP server. Return to CUDIA to check the result.",
      callback: lease.receive.pipe(
        Effect.mapError(() => new Failure("MCP OAuth callback was cancelled or closed")),
        Effect.flatMap((url) =>
          Effect.tryPromise({
            try: async (signal) => {
              const code = authorizationCode(url, state, pending.saved.issuer, pending.issuerRequired)
              const sdk = await import("@modelcontextprotocol/sdk/client/auth.js")
              const metadata = pending.saved.metadata as AuthorizationServerMetadata
              const tokens = await sdk.exchangeAuthorization(pending.saved.issuer, {
                metadata,
                clientInformation: pending.saved.client as OAuthClientInformationMixed,
                authorizationCode: code,
                codeVerifier: pending.verifier,
                redirectUri: pending.saved.redirect,
                resource: new URL(pending.saved.resource),
                fetchFn: oauthFetch(
                  signal,
                  (target, method) => method === "POST" && target.href === endpoint(metadata.token_endpoint).href,
                ),
              })
              signal.throwIfAborted()
              return credential(binding, tokens, pending.saved)
            },
            catch: bounded,
          }).pipe(
            Effect.timeoutOrElse({
              duration: binding.timeout,
              orElse: () => Effect.fail(new Failure("MCP OAuth token exchange timed out; authorize again explicitly")),
            }),
          ),
        ),
      ),
    }
  })
}

export function refresh(binding: Binding, value: Credential.OAuth): Effect.Effect<Credential.OAuth, Failure> {
  return Effect.tryPromise({
    try: async (signal) => {
      const saved = readStored(value, binding)
      if (!saved || !value.refresh) throw new Failure("MCP OAuth must be authorized again")
      const [sdk, schemas, utils] = await Promise.all([
        import("@modelcontextprotocol/sdk/client/auth.js"),
        import("@modelcontextprotocol/sdk/shared/auth.js"),
        import("@modelcontextprotocol/sdk/shared/auth-utils.js"),
      ])
      const metadata = schemas.OAuthMetadataSchema.parse(saved.metadata)
      validateIssuer(saved.issuer, metadata)
      if (
        !utils.checkResourceAllowed({
          requestedResource: endpoint(binding.server.url),
          configuredResource: endpoint(saved.resource),
        })
      )
        throw new Failure("MCP OAuth stored resource does not match this server")
      const client = schemas.OAuthClientInformationSchema.parse(saved.client)
      const tokens = await sdk.refreshAuthorization(saved.issuer, {
        metadata,
        clientInformation: client,
        refreshToken: value.refresh,
        resource: new URL(saved.resource),
        fetchFn: oauthFetch(
          signal,
          (target, method) => method === "POST" && target.href === endpoint(metadata.token_endpoint).href,
        ),
      })
      signal.throwIfAborted()
      return credential(binding, tokens, saved)
    },
    catch: bounded,
  }).pipe(
    Effect.timeoutOrElse({
      duration: binding.timeout,
      orElse: () => Effect.fail(new Failure("MCP OAuth refresh timed out; authorize again explicitly")),
    }),
  )
}

export function readStored(value: Credential.OAuth, binding: Binding) {
  const result = Schema.decodeUnknownOption(Stored)(value.metadata?.mcp)
  return result._tag === "Some" && result.value.binding === binding.integrationID ? result.value : undefined
}

function credential(binding: Binding, tokens: OAuthTokens, saved: typeof Stored.Type) {
  if (!tokens.access_token || tokens.token_type.toLowerCase() !== "bearer")
    throw new Failure("MCP OAuth did not return a usable bearer token")
  new Headers({ authorization: `Bearer ${tokens.access_token}` })
  const issued = Date.now()
  const expires = tokens.expires_in === undefined ? undefined : Math.floor(issued + tokens.expires_in * 1000)
  if (expires !== undefined && (!Number.isSafeInteger(expires) || expires < issued))
    throw new Failure("MCP OAuth returned an invalid token lifetime")
  return Credential.OAuth.make({
    type: "oauth",
    methodID: binding.methodID,
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    issued,
    expires,
    metadata: { mcp: saved },
  })
}

function authorizationCode(url: URL, state: string, issuer: string, required: boolean) {
  const params = url.searchParams
  if (
    ["state", "code", "iss", "error", "error_description"].some((name) => params.getAll(name).length > 1) ||
    params.get("state") !== state
  )
    throw new Failure("MCP OAuth callback parameters are invalid")
  const returned = params.get("iss")
  if ((required && returned === null) || (returned !== null && returned !== issuer))
    throw new Failure("MCP OAuth callback issuer does not match the selected authorization server")
  if (params.has("error") || !params.get("code")) throw new Failure("MCP OAuth authorization was not granted")
  return params.get("code")!
}

function validateIssuer(issuer: string, metadata: AuthorizationServerMetadata) {
  const selected = endpoint(issuer)
  if (selected.search || metadata.issuer !== issuer)
    throw new Failure("MCP OAuth metadata issuer does not match the selected authorization server")
  endpoint(metadata.authorization_endpoint)
  endpoint(metadata.token_endpoint)
  if (metadata.registration_endpoint) endpoint(metadata.registration_endpoint)
}

async function discoverIssuer(
  issuer: string,
  fetchFn: import("@modelcontextprotocol/sdk/shared/transport.js").FetchLike,
) {
  endpoint(issuer)
  const [{ buildDiscoveryUrls }, { OAuthMetadataSchema }] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/auth.js"),
    import("@modelcontextprotocol/sdk/shared/auth.js"),
  ])
  // The SDK's OIDC parser strips RFC 9207's flag. Its OAuth parser retains it.
  for (const candidate of buildDiscoveryUrls(issuer)) {
    const response = await fetchFn(candidate.url, { method: "GET" })
    if (!response.ok) continue
    const decoded = OAuthMetadataSchema.safeParse(await response.json().catch(() => undefined))
    if (!decoded.success) continue
    validateIssuer(issuer, decoded.data)
    const flag = decoded.data.authorization_response_iss_parameter_supported
    if (flag !== undefined && typeof flag !== "boolean")
      throw new Failure("MCP OAuth issuer response metadata is invalid")
    return decoded.data
  }
  throw new Failure("MCP OAuth authorization server metadata is unavailable")
}

function endpoint(value: string | URL) {
  const url = new URL(value)
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  )
    throw new Failure("MCP OAuth endpoints must use HTTPS or loopback HTTP")
  return url
}

/** OAuth uses a separate fetch path: no MCP headers, no credential-bearing redirects. */
function oauthFetch(
  signal: AbortSignal,
  allowed: (url: URL, method: string) => boolean,
): import("@modelcontextprotocol/sdk/shared/transport.js").FetchLike {
  return async (target, init) => {
    signal.throwIfAborted()
    const url = endpoint(new URL(target))
    const method = init?.method?.toUpperCase() ?? "GET"
    if (!allowed(url, method)) throw new Failure("MCP OAuth request does not match its validated endpoint")
    const headers = new Headers(init?.headers)
    if (method === "GET") {
      headers.delete("authorization")
      headers.delete("cookie")
      headers.delete("proxy-authorization")
    }
    const response = await fetch(url, { ...init, headers, signal, redirect: "manual" })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel()
      throw new Failure("MCP OAuth endpoint redirected; authorization must be restarted explicitly")
    }
    if (!response.body) return response
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        signal.throwIfAborted()
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 512 * 1024) throw new Failure("MCP OAuth response exceeds its limit")
        parts.push(part.value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    return new Response(Buffer.concat(parts), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    })
  }
}

function bounded(error: unknown) {
  return error instanceof Failure
    ? error
    : new Failure("MCP OAuth network or protocol operation failed; authorize again explicitly")
}
