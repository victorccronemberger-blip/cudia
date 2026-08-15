import type { Hooks, PluginInput, ProviderHookContext } from "@opencode-ai/plugin"
import type { Model, Provider } from "@opencode-ai/sdk/v2"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { OAUTH_DUMMY_KEY } from "../auth"
import { InstallationVersion } from "@opencode-ai/core/installation/version"

// Kimi Code (Moonshot) device-code OAuth. Moonshot's auth server only speaks
// RFC 8628 device authorization for the kimi-code CLI client, so there is no
// loopback callback variant here — the user opens the verification URL on any
// device, types the short user_code, and opencode long-polls the token
// endpoint. Source of truth for the flow: MoonshotAI/kimi-code
// packages/oauth/src/{constants,oauth}.ts.
export const KIMI_OAUTH_HOST = "https://auth.kimi.com"
export const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
export const KIMI_API_BASE_URL = "https://api.kimi.com/coding/v1"
const DEVICE_AUTHORIZATION_PATH = "/api/oauth/device_authorization"
const TOKEN_PATH = "/api/oauth/token"
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

// Bounds for the device-code poll loop. Kimi reports `interval` (seconds)
// but we floor it to avoid hammering and add the spec's slow_down increment
// when the server asks us to back off. The default deadline matches the
// upstream 15-minute device_code TTL.
const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 15 * 60 * 1000
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000

// Refresh the access token a little before it actually expires so a single
// long-running tool call doesn't have to recover from a mid-flight 401.
// Kimi access tokens live 15 minutes and are opaque, so the stored `expires`
// timestamp is the load-bearing signal.
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000

function envOverride(key: string): string | undefined {
  return process.env[key]
}

interface KimiAuthPluginOptions {
  oauthHost?: string
  apiBaseUrl?: string
  credentialsPath?: string
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type?: string
  expires_in?: number
  scope?: string
}

interface DeviceTokenErrorBody {
  error?: string
  error_description?: string
}

function flowConfig(options: KimiAuthPluginOptions = {}) {
  return {
    oauthHost: (
      options.oauthHost ??
      envOverride("KIMI_CODE_OAUTH_HOST") ??
      envOverride("KIMI_OAUTH_HOST") ??
      KIMI_OAUTH_HOST
    ).replace(/\/+$/, ""),
    apiBaseUrl: (options.apiBaseUrl ?? envOverride("KIMI_CODE_BASE_URL") ?? KIMI_API_BASE_URL).replace(/\/+$/, ""),
  }
}

function authHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": `opencode/${InstallationVersion}`,
  }
}

function tokenFromResponse(data: Record<string, unknown>): TokenResponse {
  // Required-field validation. Reject responses missing any of the three
  // load-bearing fields rather than persisting empty strings that will fail
  // mysteriously later.
  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    throw new Error("Kimi OAuth response missing access_token")
  }
  if (typeof data.refresh_token !== "string" || data.refresh_token.length === 0) {
    throw new Error("Kimi OAuth response missing refresh_token")
  }
  const expiresIn = Number(data.expires_in)
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error("Kimi OAuth response missing or invalid expires_in")
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    token_type: typeof data.token_type === "string" ? data.token_type : "Bearer",
    expires_in: expiresIn,
    scope: typeof data.scope === "string" ? data.scope : "",
  }
}

export async function requestDeviceCode(options: KimiAuthPluginOptions = {}): Promise<DeviceCodeResponse> {
  const { oauthHost } = flowConfig(options)
  const response = await fetch(`${oauthHost}${DEVICE_AUTHORIZATION_PATH}`, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({ client_id: KIMI_CLIENT_ID }).toString(),
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const detail = typeof data.error_description === "string" ? data.error_description : ""
    throw new Error(`Kimi device code request failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  if (
    typeof data.user_code !== "string" ||
    data.user_code.length === 0 ||
    typeof data.device_code !== "string" ||
    data.device_code.length === 0
  ) {
    throw new Error("Kimi device code response is missing user_code / device_code")
  }
  const verificationUri = typeof data.verification_uri === "string" ? data.verification_uri : ""
  const verificationUriComplete =
    typeof data.verification_uri_complete === "string" ? data.verification_uri_complete : verificationUri
  if (!verificationUriComplete) {
    throw new Error("Kimi device code response is missing verification_uri_complete")
  }
  return {
    device_code: data.device_code,
    user_code: data.user_code,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    expires_in: data.expires_in !== undefined ? Number(data.expires_in) : undefined,
    interval: data.interval !== undefined ? Number(data.interval) : undefined,
  }
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function positiveSecondsToMs(value: unknown, defaultMs: number): number {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : defaultMs
}

export async function pollDeviceCodeToken(
  device: DeviceCodeResponse,
  options: KimiAuthPluginOptions & { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<TokenResponse> {
  const { oauthHost } = flowConfig(options)
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())
  const expiresInMs = positiveSecondsToMs(device.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS)
  const deadline = now() + expiresInMs
  let intervalMs = Math.max(
    positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
    DEVICE_CODE_MIN_INTERVAL_MS,
  )

  while (now() < deadline) {
    const response = await fetch(`${oauthHost}${TOKEN_PATH}`, {
      method: "POST",
      headers: authHeaders(),
      body: new URLSearchParams({
        grant_type: DEVICE_CODE_GRANT_TYPE,
        client_id: KIMI_CLIENT_ID,
        device_code: device.device_code,
      }).toString(),
    })
    if (response.ok) return tokenFromResponse((await response.json().catch(() => ({}))) as Record<string, unknown>)

    const body = (await response.json().catch(() => ({}))) as DeviceTokenErrorBody
    const remaining = Math.max(0, deadline - now())
    // RFC 8628 §3.5: authorization_pending = keep polling at the same
    // interval; slow_down = bump the interval by ≥5s and keep polling.
    // Anything else is terminal.
    if (body.error === "authorization_pending") {
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining))
      continue
    }
    if (body.error === "slow_down") {
      intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS
      await sleep(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining))
      continue
    }
    if (body.error === "expired_token") {
      throw new Error("Kimi device code expired - please re-run login")
    }
    if (body.error === "access_denied" || body.error === "authorization_denied") {
      throw new Error("Kimi device authorization was denied")
    }
    const detail = body.error_description ?? body.error ?? ""
    throw new Error(`Kimi device token exchange failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  throw new Error("Kimi device authorization timed out")
}

export async function refreshAccessToken(
  refreshToken: string,
  options: KimiAuthPluginOptions = {},
): Promise<TokenResponse> {
  const { oauthHost } = flowConfig(options)
  const response = await fetch(`${oauthHost}${TOKEN_PATH}`, {
    method: "POST",
    headers: authHeaders(),
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: KIMI_CLIENT_ID,
      refresh_token: refreshToken,
    }).toString(),
  })
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok) {
    const detail =
      typeof data.error_description === "string"
        ? data.error_description
        : typeof data.error === "string"
          ? data.error
          : ""
    throw new Error(`Kimi token refresh failed (${response.status})${detail ? `: ${detail}` : ""}`)
  }
  return tokenFromResponse(data)
}

interface RefreshResult {
  access: string
  refresh: string
  expires: number
}

// The kimi-code CLI stores its OAuth session as
// { access_token, refresh_token, expires_at, scope, token_type, expires_in }
// under ~/.kimi-code/credentials/kimi-code.json. Importing that file lets
// opencode reuse an existing `kimi login` session, and writing rotated tokens
// back keeps both clients in sync — Kimi rotates refresh_token on every
// refresh, so two processes sharing one session would otherwise invalidate
// each other.
function kimiCredentialsPath(options: KimiAuthPluginOptions = {}) {
  return options.credentialsPath ?? path.join(Global.Path.home, ".kimi-code", "credentials", "kimi-code.json")
}

export async function readKimiCredentials(
  options: KimiAuthPluginOptions = {},
): Promise<RefreshResult | undefined> {
  try {
    const parsed = (await Bun.file(kimiCredentialsPath(options)).json()) as Record<string, unknown>
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) return
    if (typeof parsed.refresh_token !== "string" || parsed.refresh_token.length === 0) return
    const expiresAt = Number(parsed.expires_at)
    return {
      access: parsed.access_token,
      refresh: parsed.refresh_token,
      expires: Number.isFinite(expiresAt) ? expiresAt * 1000 : 0,
    }
  } catch {
    return undefined
  }
}

export async function writeKimiCredentials(tokens: RefreshResult, options: KimiAuthPluginOptions = {}): Promise<void> {
  try {
    const filePath = kimiCredentialsPath(options)
    const prev = (await Bun.file(filePath).json().catch(() => ({}))) as Record<string, unknown>
    await Bun.write(
      filePath,
      JSON.stringify(
        {
          ...(typeof prev === "object" && prev !== null ? prev : {}),
          access_token: tokens.access,
          refresh_token: tokens.refresh,
          expires_at: Math.floor(tokens.expires / 1000),
        },
        null,
        2,
      ),
    )
  } catch {}
}

// Capabilities reported by the coding API's /models endpoint: reasoning-only
// models with image/video input support and full tool calling.
function codingModels(apiBaseUrl: string): Record<string, Model> {
  const base = {
    providerID: "moonshotai",
    api: {
      id: "",
      npm: "@ai-sdk/openai-compatible",
      url: apiBaseUrl,
    },
    family: "kimi",
    capabilities: {
      temperature: false,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: true, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: { field: "reasoning_content" as const },
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    status: "active" as const,
    options: {},
    headers: {},
    release_date: "",
  }

  const make = (id: string, name: string, context: number, video: boolean): Model => ({
    ...base,
    id,
    api: { ...base.api, id },
    name,
    limit: { context, output: context },
    capabilities: {
      ...base.capabilities,
      input: { ...base.capabilities.input, video },
    },
  })

  return Object.fromEntries(
    [
      make("kimi-for-coding", "Kimi for Coding", 262144, true),
      make("kimi-for-coding-highspeed", "Kimi for Coding Highspeed", 262144, true),
      make("k3", "Kimi K3", 1048576, true),
      make("k3-256k", "Kimi K3 256K", 262144, false),
    ].map((model) => [model.id, model]),
  )
}

export async function KimiAuthPlugin(input: PluginInput, options: KimiAuthPluginOptions = {}): Promise<Hooks> {
  const { apiBaseUrl } = flowConfig(options)

  return {
    provider: {
      id: "moonshotai",
      async models(provider: Provider, ctx: ProviderHookContext) {
        // OAuth tokens from auth.kimi.com only work against the coding API,
        // whose model catalog differs from the api.moonshot.ai API-key
        // platform. Swap in the coding models when logged in via OAuth.
        if (ctx.auth?.type !== "oauth") return provider.models
        return codingModels(apiBaseUrl)
      },
    },
    auth: {
      provider: "moonshotai",
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth.type !== "oauth") return {}

        // Single-flight refresh: collapse concurrent fetches from this loaded
        // provider onto one HTTP call so we don't replay a rotating refresh_token.
        let refreshPromise: Promise<RefreshResult> | undefined

        const persist = async (tokens: RefreshResult) => {
          // Persist the rotated pair as best-effort. Kimi has already consumed
          // the old refresh_token by the time we get here; a failure leaves the
          // on-disk state stale but the in-memory result is still valid for
          // this turn.
          await input.client.auth
            .set({
              path: { id: "moonshotai" },
              body: {
                type: "oauth",
                access: tokens.access,
                refresh: tokens.refresh,
                expires: tokens.expires,
              },
            })
            .catch(() => {})
          // Keep the shared kimi-code credentials file in sync so the kimi CLI
          // doesn't get invalidated by the rotation.
          await writeKimiCredentials(tokens, options)
        }

        return {
          // Dummy bearer keeps the AI SDK from bailing on "missing apiKey"; the
          // real OAuth token is injected by the fetch override below.
          apiKey: OAUTH_DUMMY_KEY,
          baseURL: apiBaseUrl,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            let currentAuth = await getAuth()
            // Auth can flip from oauth to api mid-session (user re-runs
            // /connect with a pasted key). When that happens, pass the
            // request through untouched so the AI SDK's own apiKey-based
            // Authorization header reaches Moonshot unmodified.
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            const expiresSoon =
              !currentAuth.expires || currentAuth.expires - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS
            if (expiresSoon) {
              if (!refreshPromise) {
                refreshPromise = (async () => {
                  // If the kimi CLI logged in / refreshed after opencode did,
                  // its credentials file holds a newer (rotated) session. Adopt
                  // it before spending a round-trip on a dead refresh_token.
                  const shared = await readKimiCredentials(options)
                  const source = shared && shared.refresh !== currentAuth.refresh ? shared : currentAuth
                  try {
                    const tokens = await refreshAccessToken(source.refresh, options)
                    const result = { access: tokens.access_token, refresh: tokens.refresh_token, expires: Date.now() + (tokens.expires_in ?? 900) * 1000 }
                    await persist(result)
                    return result
                  } catch (error) {
                    // The peer may have rotated the refresh_token while we were
                    // refreshing. Adopt the file's fresher session and retry once.
                    const fresh = await readKimiCredentials(options)
                    if (fresh && fresh.refresh !== source.refresh) {
                      const tokens = await refreshAccessToken(fresh.refresh, options)
                      const result = { access: tokens.access_token, refresh: tokens.refresh_token, expires: Date.now() + (tokens.expires_in ?? 900) * 1000 }
                      await persist(result)
                      return result
                    }
                    throw error
                  }
                })().finally(() => {
                  refreshPromise = undefined
                })
              }
              const refreshed = await refreshPromise
              currentAuth = { ...currentAuth, ...refreshed }
            }

            // Copy the caller's headers into a fresh Headers (case-insensitive)
            // so we never mutate the RequestInit the AI SDK may reuse on retry.
            // Headers.set overwrites case-insensitively, which kills the dummy
            // bearer the AI SDK injected from apiKey in a single line.
            const headers = new Headers(requestInput instanceof Request ? requestInput.headers : undefined)
            if (init?.headers) {
              const entries =
                init.headers instanceof Headers
                  ? init.headers.entries()
                  : Array.isArray(init.headers)
                    ? init.headers
                    : Object.entries(init.headers as Record<string, string | undefined>)
              for (const [key, value] of entries) {
                if (value !== undefined) headers.set(key, String(value))
              }
            }
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            headers.set("User-Agent", `opencode/${InstallationVersion}`)

            return fetch(requestInput, { ...init, headers })
          },
        }
      },
      methods: [
        {
          label: "Kimi Code OAuth (Kimi subscription)",
          type: "oauth",
          authorize: async () => {
            const device = await requestDeviceCode(options)
            const browserUrl = device.verification_uri_complete ?? device.verification_uri
            return {
              url: browserUrl,
              instructions: `Open ${device.verification_uri || browserUrl} in your browser and enter code: ${device.user_code}`,
              method: "auto" as const,
              callback: async () => {
                try {
                  const tokens = await pollDeviceCodeToken(device, options)
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 900) * 1000,
                  }
                } catch (err) {
                  return { type: "failed" as const }
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
  }
}
