import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { OAUTH_DUMMY_KEY } from "../../auth"
import os from "os"
import { setTimeout as sleep } from "node:timers/promises"
import { OpenAIWebSocketPool } from "./ws-pool"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { NativeChatGPT } from "./chatgpt"
import { z } from "zod"

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
const ISSUER = "https://auth.openai.com"
const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3000

export interface IdTokenClaims {
  chatgpt_account_id?: string
  chatgpt_compute_residency?: string
  organizations?: Array<{ id: string }>
  email?: string
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string
    chatgpt_compute_residency?: string
  }
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".")
  if (parts.length !== 3) return undefined
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return undefined
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  )
}

export function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token)
    const accountId = claims && extractAccountIdFromClaims(claims)
    if (accountId) return accountId
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token)
    return claims ? extractAccountIdFromClaims(claims) : undefined
  }
  return undefined
}

export function extractResidency(token: string): string | undefined {
  const claims = parseJwtClaims(token)
  const residency =
    claims?.["https://api.openai.com/auth"]?.chatgpt_compute_residency ?? claims?.chatgpt_compute_residency
  if (!residency || residency === "no_constraint") return undefined
  return residency
}

interface TokenResponse {
  id_token: string
  access_token: string
  refresh_token: string
  expires_in?: number
}

interface CodexAuthPluginOptions {
  issuer?: string
  codexApiEndpoint?: string
  experimentalWebSockets?: boolean
  chatgpt?: NativeChatGPT.Options
  deviceTimeoutMs?: number
}

function tokenResponse(value: unknown, previousRefresh?: string): TokenResponse {
  const token = z
    .object({
      id_token: z.string().optional(),
      access_token: z.string().trim().min(1),
      refresh_token: z.string().trim().min(1).optional(),
      expires_in: z
        .number()
        .int()
        .positive()
        .refine((value) => Number.isSafeInteger(Date.now() + value * 1000))
        .optional(),
    })
    .parse(value)
  const refresh = token.refresh_token ?? previousRefresh
  if (!refresh) throw new Error("ChatGPT token response is missing refresh_token")
  return { ...token, id_token: token.id_token ?? "", refresh_token: refresh }
}

async function refreshAccessToken(refreshToken: string, issuer = ISSUER): Promise<TokenResponse> {
  const response = await fetch(`${issuer}/oauth/token`, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  })
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`)
  }
  return tokenResponse(await response.json(), refreshToken)
}

// Kept as a named export for plugin.codex tests; delegates to the shared branded page.
export const renderOAuthError = (error: string) => OauthCallbackPage.error(error, { provider: "ChatGPT" })

export async function CodexAuthPlugin(input: PluginInput, options: CodexAuthPluginOptions = {}): Promise<Hooks> {
  const native = await NativeChatGPT.create(options.chatgpt)
  const issuer = options.issuer ?? ISSUER
  const codexApiEndpoint = options.codexApiEndpoint ?? CODEX_API_ENDPOINT
  let websocketFetchInstalled = false
  const websocketFetches: Array<ReturnType<typeof OpenAIWebSocketPool.createWebSocketFetch>> = []
  const deviceFlows = new Set<AbortController>()

  return {
    async dispose() {
      native.dispose()
      for (const controller of deviceFlows) controller.abort(new Error("ChatGPT device login closed"))
      deviceFlows.clear()
      for (const websocketFetch of websocketFetches) websocketFetch.close()
      websocketFetches.length = 0
    },
    async event(input) {
      if (input.event.type !== "session.deleted") return
      for (const websocketFetch of websocketFetches) websocketFetch.remove(input.event.properties.info.id)
    },
    provider: {
      id: "openai",
      async models(provider, ctx) {
        if (ctx.auth?.type !== "oauth") return provider.models
        if (NativeChatGPT.isNative(ctx.auth)) return native.models(provider, ctx.auth)

        return Object.fromEntries(
          Object.entries(provider.models).map(([modelID, model]) => [
            modelID,
            {
              ...model,
              cost: {
                input: 0,
                output: 0,
                cache: { read: 0, write: 0 },
              },
              limit:
                model.id.includes("gpt-5.5") || model.id.includes("gpt-5.6")
                  ? {
                      context: 400_000,
                      input: 272_000,
                      output: 128_000,
                    }
                  : model.limit,
            },
          ]),
        )
      },
    },
    auth: {
      provider: "openai",
      async loader(getAuth) {
        const auth = await getAuth()
        if (NativeChatGPT.isNative(auth)) return native.loader(getAuth)
        const websocketFetch = options.experimentalWebSockets
          ? OpenAIWebSocketPool.createWebSocketFetch({ httpFetch: fetch })
          : undefined
        if (websocketFetch) {
          websocketFetches.push(websocketFetch)
          websocketFetchInstalled = true
        }
        if (auth.type !== "oauth") return websocketFetch ? { fetch: websocketFetch } : {}

        let refreshPromise:
          | Promise<{
              access: string
              accountId: string | undefined
            }>
          | undefined

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const currentAuth = await getAuth()
            if (!currentAuth || currentAuth.type !== "oauth")
              return websocketFetch ? websocketFetch(requestInput, init) : fetch(requestInput, init)

            const authWithAccount = currentAuth as typeof currentAuth & { accountId?: string }

            if (!currentAuth.access || currentAuth.expires < Date.now()) {
              if (!refreshPromise) {
                refreshPromise = refreshAccessToken(currentAuth.refresh, issuer)
                  .then(async (tokens) => {
                    const accountId = extractAccountId(tokens) || authWithAccount.accountId
                    const saved = await input.client.auth.set({
                      path: { id: "openai" },
                      throwOnError: true,
                      body: {
                        type: "oauth",
                        refresh: tokens.refresh_token,
                        access: tokens.access_token,
                        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                        ...(accountId && { accountId }),
                      },
                    })
                    if (saved && typeof saved === "object" && "error" in saved && saved.error)
                      throw new Error("Failed to save renewed ChatGPT credentials")
                    return {
                      access: tokens.access_token,
                      accountId,
                    }
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }

              const refreshed = await refreshPromise
              currentAuth.access = refreshed.access
              authWithAccount.accountId = refreshed.accountId
            }

            const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
            if (init?.headers) {
              if (init.headers instanceof Headers) {
                init.headers.forEach((value, key) => headers.set(key, value))
              } else if (Array.isArray(init.headers)) {
                for (const [key, value] of init.headers) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              } else {
                for (const [key, value] of Object.entries(init.headers)) {
                  if (value !== undefined) headers.set(key, String(value))
                }
              }
            }
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            if (authWithAccount.accountId) {
              headers.set("ChatGPT-Account-Id", authWithAccount.accountId)
            }

            const parsed =
              requestInput instanceof URL
                ? requestInput
                : new URL(typeof requestInput === "string" ? requestInput : requestInput.url)
            const rewrite = parsed.pathname.includes("/v1/responses") || parsed.pathname.includes("/chat/completions")
            const url = rewrite ? new URL(codexApiEndpoint) : parsed
            if (rewrite) {
              const residency = extractResidency(currentAuth.access)
              if (residency) headers.set("x-openai-internal-codex-residency", residency)
            }

            const requestInit = {
              ...init,
              body: init?.body,
              headers,
            }
            if (websocketFetch && parsed.pathname.endsWith("/responses")) return websocketFetch(url, requestInit)
            return fetch(url, OpenAIWebSocketPool.withoutInternalHeaders(requestInit))
          },
        }
      },
      methods: [
        native.method,
        {
          label: "ChatGPT (legacy Codex device login)",
          type: "oauth",
          authorize: async () => {
            const controller = new AbortController()
            deviceFlows.add(controller)
            const signal = AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(options.deviceTimeoutMs ?? 15 * 60_000),
            ])
            const deviceResponse = await fetch(`${issuer}/api/accounts/deviceauth/usercode`, {
              method: "POST",
              signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
              headers: {
                "Content-Type": "application/json",
                "User-Agent": `opencode/${InstallationVersion}`,
              },
              body: JSON.stringify({ client_id: CLIENT_ID }),
            })

            if (!deviceResponse.ok) throw new Error("Failed to initiate device authorization")

            const deviceData = z
              .object({
                device_auth_id: z.string().min(1),
                user_code: z.string().min(1),
                interval: z.union([z.string(), z.number()]).optional(),
              })
              .parse(await deviceResponse.json())
            const interval = Math.min(Math.max(Number(deviceData.interval) || 5, 1), 60) * 1000

            return {
              url: `${issuer}/codex/device`,
              instructions: `Enter code: ${deviceData.user_code}`,
              method: "auto" as const,
              async callback() {
                try {
                  while (true) {
                    signal.throwIfAborted()
                    const response = await fetch(`${issuer}/api/accounts/deviceauth/token`, {
                      method: "POST",
                      signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
                      headers: {
                        "Content-Type": "application/json",
                        "User-Agent": `opencode/${InstallationVersion}`,
                      },
                      body: JSON.stringify({
                        device_auth_id: deviceData.device_auth_id,
                        user_code: deviceData.user_code,
                      }),
                    })

                    if (response.ok) {
                      const data = z
                        .object({ authorization_code: z.string().min(1), code_verifier: z.string().min(1) })
                        .parse(await response.json())

                      const exchanged = await fetch(`${issuer}/oauth/token`, {
                        method: "POST",
                        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
                        headers: { "Content-Type": "application/x-www-form-urlencoded" },
                        body: new URLSearchParams({
                          grant_type: "authorization_code",
                          code: data.authorization_code,
                          redirect_uri: `${issuer}/deviceauth/callback`,
                          client_id: CLIENT_ID,
                          code_verifier: data.code_verifier,
                        }).toString(),
                      })

                      if (!exchanged.ok) {
                        throw new Error(`Token exchange failed: ${exchanged.status}`)
                      }

                      const tokens = tokenResponse(await exchanged.json())

                      return {
                        type: "success" as const,
                        refresh: tokens.refresh_token,
                        access: tokens.access_token,
                        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                        accountId: extractAccountId(tokens),
                      }
                    }

                    if (response.status !== 403 && response.status !== 404) {
                      return { type: "failed" as const }
                    }

                    await sleep(interval + OAUTH_POLLING_SAFETY_MARGIN_MS, undefined, { signal })
                  }
                } finally {
                  deviceFlows.delete(controller)
                }
              },
            }
          },
        },
        {
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "openai") return
      output.headers.originator = "opencode"
      output.headers["User-Agent"] = `opencode/${InstallationVersion} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers["session-id"] = input.sessionID
      // Temporary fetch-layer hack: title generation currently shares the conversation
      // session ID, so the OpenAI plugin marks it for HTTP fallback until transport
      // context can be passed directly instead of smuggled through headers.
      if (websocketFetchInstalled && input.agent === "title") output.headers[OpenAIWebSocketPool.TITLE_HEADER] = "true"
    },
    "chat.params": async (input, output) => {
      if (input.model.providerID !== "openai") return
      // Match codex cli
      output.maxOutputTokens = undefined
    },
  }
}
