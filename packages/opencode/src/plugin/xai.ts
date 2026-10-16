import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { OAUTH_DUMMY_KEY } from "../auth"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { createHash } from "node:crypto"

// Public Grok-CLI OAuth client.
const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
const TOKEN_URL = "https://auth.x.ai/oauth2/token"
const OAUTH_API_BASE = "https://cli-chat-proxy.grok.com"
// The official Grok CLI proxy requires this version header and rejects
// missing/old clients with HTTP 426. This tracks xai-grok-shell's published
// xai_grok_version crate (currently 1.0.45).
const GROK_CLI_VERSION = "1.0.45"
// RFC 8628 device authorization grant. Confirmed exposed by xAI's
// /.well-known/openid-configuration as `device_authorization_endpoint`
// with the matching `urn:ietf:params:oauth:grant-type:device_code` grant
// in `grant_types_supported`. This is the headless / VPS path: no
// loopback callback server, no SSH port forwarding, no inbound firewall
// holes — the user opens the URL on any device with a browser, types
// the short user_code, and the CLI long-polls the token endpoint.
const DEVICE_AUTHORIZATION_URL = "https://auth.x.ai/oauth2/device/code"
const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"
const SCOPE = "openid profile email offline_access grok-cli:access api:access"

// Bounds for the device-code poll loop. xAI returns `interval` (seconds)
// but we floor it to avoid hammering and we add the spec's slow_down
// increment when xAI explicitly asks us to back off.
const DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000
const DEVICE_CODE_MIN_INTERVAL_MS = 1_000
const DEVICE_CODE_SLOW_DOWN_INCREMENT_MS = 5_000
const DEVICE_CODE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000
const MAX_DEVICE_CODE_DURATION_MS = 60 * 60 * 1000
const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000

// Refresh the access token a little before it actually expires so a single
// long-running tool call doesn't have to recover from a mid-flight 401.
const ACCESS_TOKEN_REFRESH_SKEW_MS = 120_000
const AUTH_REQUEST_TIMEOUT_MS = 30_000
const MAX_AUTH_REQUEST_TIMEOUT_MS = 120_000

interface XaiAuthPluginOptions {
  tokenUrl?: string
  deviceAuthorizationUrl?: string
  requestTimeoutMs?: number
  oauthApiBase?: string
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  id_token?: string
  token_type?: string
  expires_in?: number
  scope?: string
}

function authHeaders() {
  return {
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": `opencode/${InstallationVersion}`,
  }
}

interface RefreshResult {
  access: string
  refresh: string
  expires: number
}

const refreshFlights = new Map<string, Promise<RefreshResult>>()

function requestTimeout(options: XaiAuthPluginOptions) {
  const timeout = options.requestTimeoutMs ?? AUTH_REQUEST_TIMEOUT_MS
  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_AUTH_REQUEST_TIMEOUT_MS)
    throw new Error(`xAI request timeout must be between 1 and ${MAX_AUTH_REQUEST_TIMEOUT_MS} milliseconds`)
  return timeout
}

async function fetchBounded(
  input: RequestInfo | URL,
  init: RequestInit,
  options: XaiAuthPluginOptions,
  signal?: AbortSignal,
) {
  if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  const controller = new AbortController()
  const timeout = requestTimeout(options)
  const onAbort = () => controller.abort(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"))
  signal?.addEventListener("abort", onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new DOMException("xAI request timed out", "TimeoutError")), timeout)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error
    if (controller.signal.aborted) throw controller.signal.reason ?? error
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", onAbort)
  }
}

function parseTokenResponse(value: unknown, requireRefresh: boolean): TokenResponse {
  if (!value || typeof value !== "object") throw new Error("xAI token response is invalid")
  const response = value as Record<string, unknown>
  if (typeof response.access_token !== "string" || response.access_token.trim().length === 0)
    throw new Error("xAI token response is missing access_token")
  if (requireRefresh && (typeof response.refresh_token !== "string" || response.refresh_token.trim().length === 0))
    throw new Error("xAI token response is missing refresh_token")
  if (
    response.refresh_token !== undefined &&
    (typeof response.refresh_token !== "string" || response.refresh_token.trim().length === 0)
  )
    throw new Error("xAI token response has an invalid refresh_token")
  if (
    response.expires_in !== undefined &&
    (typeof response.expires_in !== "number" ||
      !Number.isSafeInteger(response.expires_in) ||
      response.expires_in <= 0 ||
      !Number.isSafeInteger(response.expires_in * 1000) ||
      !Number.isSafeInteger(Date.now() + response.expires_in * 1000))
  ) {
    throw new Error("xAI token response has an invalid expires_in")
  }
  return response as unknown as TokenResponse
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      reject(signal?.reason ?? new DOMException("The operation was aborted", "AbortError"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

async function readJsonBounded(
  response: Response,
  options: XaiAuthPluginOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) {
    await response.body?.cancel(signal.reason).catch(() => {})
    throw signal.reason ?? new DOMException("The operation was aborted", "AbortError")
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = (reason: unknown) => {
    void response.body?.cancel(reason).catch(() => {})
  }
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException("xAI response timed out", "TimeoutError")
      cancel(error)
      reject(error)
    }, requestTimeout(options))
  })
  let onAbort: (() => void) | undefined
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => {
          const error = signal.reason ?? new DOMException("The operation was aborted", "AbortError")
          cancel(error)
          reject(error)
        }
        signal.addEventListener("abort", onAbort, { once: true })
      })
    : undefined
  try {
    return await Promise.race(aborted ? [response.json(), timeout, aborted] : [response.json(), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal?.removeEventListener("abort", onAbort)
  }
}

// Parse the `exp` claim out of a JWT access_token without verifying the
// signature. We only use this to decide whether to proactively refresh, never
// to make trust decisions, so unsigned decode is safe. Returns false for
// opaque tokens (no JWT shape), which conservatively skips the proactive
// refresh and lets the 401-on-call path drive the refresh instead.
export function accessTokenIsExpiring(
  token: string | undefined,
  skewMs: number = ACCESS_TOKEN_REFRESH_SKEW_MS,
): boolean {
  if (!token || typeof token !== "string") return false
  const parts = token.split(".")
  if (parts.length < 2) return false
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/")
    while (payload.length % 4 !== 0) payload += "="
    const claims = JSON.parse(Buffer.from(payload, "base64").toString("utf8"))
    if (typeof claims?.exp !== "number") return false
    return claims.exp * 1000 <= Date.now() + Math.max(0, skewMs)
  } catch {
    return false
  }
}

async function refreshAccessToken(refreshToken: string, options: XaiAuthPluginOptions = {}): Promise<TokenResponse> {
  const response = await fetchBounded(
    options.tokenUrl ?? TOKEN_URL,
    {
      method: "POST",
      headers: authHeaders(),
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }).toString(),
    },
    options,
  )
  if (!response.ok) throw new Error(`xAI token refresh failed (${response.status})`)
  return parseTokenResponse(await readJsonBounded(response, options), false)
}

function refreshAndPersist(refreshToken: string, input: PluginInput, options: XaiAuthPluginOptions) {
  const endpoint = options.tokenUrl ?? TOKEN_URL
  const key = createHash("sha256").update(endpoint).update("\0").update(refreshToken).digest("hex")
  const existing = refreshFlights.get(key)
  if (existing) return existing

  const flight = (async () => {
    const tokens = await refreshAccessToken(refreshToken, options)
    const result = {
      access: tokens.access_token,
      refresh: tokens.refresh_token || refreshToken,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    }
    const persisted = await input.client.auth.set({
      path: { id: "xai" },
      body: {
        type: "oauth",
        access: result.access,
        refresh: result.refresh,
        expires: result.expires,
      },
      throwOnError: true,
    })
    if (persisted && typeof persisted === "object" && "error" in persisted && persisted.error)
      throw new Error("xAI refreshed credentials could not be saved")
    return result
  })()
  refreshFlights.set(key, flight)
  void flight.then(
    () => {
      if (refreshFlights.get(key) === flight) refreshFlights.delete(key)
    },
    () => {
      if (refreshFlights.get(key) === flight) refreshFlights.delete(key)
    },
  )
  return flight
}

export interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}

interface DeviceTokenErrorBody {
  error?: string
  error_description?: string
}

export async function requestDeviceCode(
  options: XaiAuthPluginOptions & { signal?: AbortSignal } = {},
): Promise<DeviceCodeResponse> {
  const response = await fetchBounded(
    options.deviceAuthorizationUrl ?? DEVICE_AUTHORIZATION_URL,
    {
      method: "POST",
      headers: authHeaders(),
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        scope: SCOPE,
        referrer: "opencode",
      }).toString(),
    },
    options,
    options.signal,
  )
  if (!response.ok) throw new Error(`xAI device code request failed (${response.status})`)
  const value = await readJsonBounded(response, options, options.signal)
  if (!value || typeof value !== "object") throw new Error("xAI device code response is invalid")
  const json = value as Record<string, unknown>
  if (
    typeof json.device_code !== "string" ||
    !json.device_code ||
    typeof json.user_code !== "string" ||
    !json.user_code ||
    typeof json.verification_uri !== "string" ||
    !json.verification_uri ||
    (json.verification_uri_complete !== undefined && typeof json.verification_uri_complete !== "string")
  ) {
    throw new Error("xAI device code response is missing device_code / user_code / verification_uri")
  }
  return json as unknown as DeviceCodeResponse
}

// Normalize a server-supplied seconds value to milliseconds, falling back to
// the supplied default when the input is missing, non-positive, or not a
// finite number. Defends the polling loop against garbage like `NaN`, `"NaN"`,
// `null`, or `-5` from a misbehaving device-code endpoint — without this,
// a NaN interval would slip through `?? default` (NaN is typeof number),
// reach `setTimeout(_, NaN)` which is treated as 0, and busy-loop until the
// hard deadline. Matches the defensive normalization Codex uses for the same
// field (`parseInt(deviceData.interval) || 5`).
function positiveSecondsToMs(value: unknown, defaultMs: number): number {
  const seconds = Number(value)
  const milliseconds = seconds * 1000
  return Number.isFinite(milliseconds) && milliseconds > 0
    ? Math.min(milliseconds, MAX_DEVICE_CODE_DURATION_MS)
    : defaultMs
}

export async function pollDeviceCodeToken(
  device: DeviceCodeResponse,
  options: XaiAuthPluginOptions & {
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
    now?: () => number
    signal?: AbortSignal
  } = {},
): Promise<TokenResponse> {
  const delay = options.sleep ?? sleep
  const now = options.now ?? (() => Date.now())
  const expiresInMs = positiveSecondsToMs(device.expires_in, DEVICE_CODE_DEFAULT_EXPIRES_MS)
  const deadline = now() + expiresInMs
  let intervalMs = Math.max(
    positiveSecondsToMs(device.interval, DEVICE_CODE_DEFAULT_INTERVAL_MS),
    DEVICE_CODE_MIN_INTERVAL_MS,
  )

  while (now() < deadline) {
    if (options.signal?.aborted)
      throw options.signal.reason ?? new DOMException("The operation was aborted", "AbortError")
    const remainingBeforeRequest = deadline - now()
    if (remainingBeforeRequest <= 0) break
    const pollOptions = {
      ...options,
      requestTimeoutMs: Math.min(requestTimeout(options), remainingBeforeRequest),
    }
    const response = await fetchBounded(
      options.tokenUrl ?? TOKEN_URL,
      {
        method: "POST",
        headers: authHeaders(),
        body: new URLSearchParams({
          grant_type: DEVICE_CODE_GRANT_TYPE,
          client_id: CLIENT_ID,
          device_code: device.device_code,
        }).toString(),
      },
      pollOptions,
      options.signal,
    )
    const responseOptions = {
      ...options,
      requestTimeoutMs: Math.min(requestTimeout(options), Math.max(1, deadline - now())),
    }
    if (response.ok) return parseTokenResponse(await readJsonBounded(response, responseOptions, options.signal), true)

    const body = (await readJsonBounded(response, responseOptions, options.signal).catch(
      () => ({}),
    )) as DeviceTokenErrorBody
    const remaining = Math.max(0, deadline - now())
    // RFC 8628 §3.5: authorization_pending = keep polling at the same
    // interval; slow_down = bump the interval by ≥5s and keep polling.
    // Anything else is terminal.
    if (body.error === "authorization_pending") {
      await delay(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining), options.signal)
      continue
    }
    if (body.error === "slow_down") {
      intervalMs += DEVICE_CODE_SLOW_DOWN_INCREMENT_MS
      await delay(Math.min(intervalMs + OAUTH_POLLING_SAFETY_MARGIN_MS, remaining), options.signal)
      continue
    }
    if (body.error === "access_denied" || body.error === "authorization_denied") {
      throw new Error("xAI device authorization was denied")
    }
    if (body.error === "expired_token") {
      throw new Error("xAI device code expired - please re-run login")
    }
    const detail = ["server_error", "temporarily_unavailable", "invalid_grant"].includes(body.error ?? "")
      ? `: ${body.error}`
      : ""
    throw new Error(`xAI device token exchange failed (${response.status})${detail}`)
  }
  throw new Error("xAI device authorization timed out")
}

function replayableBody(body: BodyInit | null | undefined) {
  return (
    body === undefined ||
    body === null ||
    typeof body === "string" ||
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof FormData
  )
}

function canReplay(requestInput: RequestInfo | URL, init?: RequestInit) {
  if (requestInput instanceof Request && requestInput.bodyUsed) return false
  if (requestInput instanceof Request && requestInput.body !== null && init?.body === undefined) return false
  return replayableBody(init?.body)
}

function requestHeaders(requestInput: RequestInfo | URL, init?: RequestInit) {
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
  return headers
}

function oauthCompletionUrl(requestInput: RequestInfo | URL, options: XaiAuthPluginOptions) {
  const inputUrl = requestInput instanceof Request ? requestInput.url : requestInput.toString()
  const url = new URL(inputUrl)
  const endpoint = url.pathname.match(/^\/v1\/(chat\/completions|responses)$/)?.[1]
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.x.ai" ||
    (url.port !== "" && url.port !== "443") ||
    !endpoint
  ) {
    return undefined
  }
  const base = new URL(options.oauthApiBase ?? OAUTH_API_BASE)
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost")
    throw new Error("xAI OAuth API base must use HTTPS")
  const target = new URL(`/v1/${endpoint}`, base)
  target.search = url.search
  return target
}

async function requestModel(requestInput: RequestInfo | URL, init?: RequestInit) {
  const body = init?.body
  try {
    const value =
      typeof body === "string"
        ? JSON.parse(body)
        : requestInput instanceof Request && init?.body === undefined
          ? await requestInput.clone().json()
          : undefined
    return value && typeof value === "object" && typeof (value as { model?: unknown }).model === "string"
      ? (value as { model: string }).model
      : undefined
  } catch {
    return undefined
  }
}

export async function XaiAuthPlugin(input: PluginInput, options: XaiAuthPluginOptions = {}): Promise<Hooks> {
  const deviceFlows = new Set<AbortController>()
  return {
    async dispose() {
      for (const controller of deviceFlows) {
        controller.abort(new DOMException("xAI auth flow stopped", "AbortError"))
      }
      deviceFlows.clear()
    },
    auth: {
      provider: "xai",
      async loader(getAuth) {
        const auth = await getAuth()
        if (!auth || auth.type !== "oauth") return {}

        return {
          // Dummy bearer keeps the AI SDK from bailing on "missing apiKey"; the
          // real OAuth token is injected by the fetch override below.
          // We intentionally do NOT set baseURL — @ai-sdk/xai already defaults
          // to https://api.x.ai/v1 and overriding here would silently route
          // around a user-configured gateway.
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const currentAuth = await getAuth()
            // Auth can flip from oauth to api mid-session (user re-runs
            // /connect with a pasted key). When that happens, pass the
            // request through untouched so the AI SDK's own apiKey-based
            // Authorization header reaches xAI unmodified.
            if (!currentAuth || currentAuth.type !== "oauth") return fetch(requestInput, init)

            let oauthAuth = currentAuth

            const signal = init?.signal ?? (requestInput instanceof Request ? requestInput.signal : undefined)
            if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError")

            // Refresh either when the stored expires timestamp is within the
            // skew window, or — for JWT access tokens — when the JWT exp
            // claim itself is. The stored expires field is best-effort
            // (xAI doesn't always return expires_in) so the JWT check is the
            // load-bearing one for tokens that lack a fresh stored deadline.
            const expiresSoon =
              !oauthAuth.expires ||
              oauthAuth.expires - Date.now() <= ACCESS_TOKEN_REFRESH_SKEW_MS ||
              accessTokenIsExpiring(oauthAuth.access)
            const refresh = async (afterUnauthorized = false) => {
              if (afterUnauthorized) {
                const latestAuth = await getAuth()
                if (!latestAuth || latestAuth.type !== "oauth") return false
                const changed = latestAuth.access !== oauthAuth.access || latestAuth.refresh !== oauthAuth.refresh
                oauthAuth = latestAuth
                if (changed && latestAuth.expires > Date.now() && !accessTokenIsExpiring(latestAuth.access)) return true
              }
              const refreshed = await waitWithSignal(refreshAndPersist(oauthAuth.refresh, input, options), signal)
              oauthAuth = { ...oauthAuth, ...refreshed }
              return true
            }
            if (expiresSoon) await refresh()

            const headers = requestHeaders(requestInput, init)
            headers.set("authorization", `Bearer ${oauthAuth.access}`)
            headers.set("User-Agent", `opencode/${InstallationVersion}`)

            const targetUrl = oauthCompletionUrl(requestInput, options)
            let outgoingInput = requestInput
            if (targetUrl) {
              const model = await requestModel(requestInput, init)
              if (!model) throw new Error("xAI OAuth chat completion requires a model in the request body")
              headers.set("X-XAI-Token-Auth", "xai-grok-cli")
              headers.set("x-grok-model-override", model)
              headers.set("x-grok-client-version", GROK_CLI_VERSION)
              outgoingInput = requestInput instanceof Request ? new Request(targetUrl, requestInput) : targetUrl
            }

            const response = await fetch(outgoingInput, { ...init, headers })
            if (response.status !== 401 || !canReplay(requestInput, init)) return response
            if (signal?.aborted) return response

            let refreshed: boolean
            try {
              refreshed = await refresh(true)
            } catch (error) {
              await response.body?.cancel().catch(() => {})
              throw error
            }
            if (!refreshed) return response
            await response.body?.cancel().catch(() => {})
            if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError")

            const retryHeaders = requestHeaders(requestInput, init)
            retryHeaders.set("authorization", `Bearer ${oauthAuth.access}`)
            retryHeaders.set("User-Agent", `opencode/${InstallationVersion}`)
            if (targetUrl) {
              retryHeaders.set("X-XAI-Token-Auth", "xai-grok-cli")
              retryHeaders.set("x-grok-model-override", (await requestModel(requestInput, init))!)
              retryHeaders.set("x-grok-client-version", GROK_CLI_VERSION)
            }
            const retryInput = targetUrl
              ? requestInput instanceof Request
                ? new Request(targetUrl, requestInput.clone())
                : targetUrl
              : requestInput instanceof Request
                ? requestInput.clone()
                : requestInput
            return fetch(retryInput, { ...init, headers: retryHeaders })
          },
        }
      },
      methods: [
        {
          // RFC 8628 device-code flow. The CLI prints a verification URL
          // and a short user_code that the user enters in a browser on
          // any device. No loopback callback server runs on the CLI host,
          // so this works on VPS / SSH / Docker / CI / WSL / any
          // environment where 127.0.0.1:56121 isn't reachable from the
          // user's browser. Defends the only attack surface (the polling
          // loop) with the standard authorization_pending / slow_down
          // backoff and a hard deadline from xAI's `expires_in`.
          label: "SuperGrok Subscription",
          type: "oauth",
          authorize: async () => {
            const controller = new AbortController()
            deviceFlows.add(controller)
            let device: DeviceCodeResponse
            try {
              device = await requestDeviceCode({ ...options, signal: controller.signal })
            } catch (error) {
              deviceFlows.delete(controller)
              throw error
            }
            const browserUrl = device.verification_uri_complete ?? device.verification_uri
            return {
              url: browserUrl,
              instructions: `Open ${device.verification_uri} on any device and enter code: ${device.user_code}`,
              method: "auto" as const,
              callback: async () => {
                try {
                  const tokens = await pollDeviceCodeToken(device, { ...options, signal: controller.signal })
                  if (!tokens.refresh_token) throw new Error("xAI token response is missing refresh_token")
                  return {
                    type: "success" as const,
                    refresh: tokens.refresh_token,
                    access: tokens.access_token,
                    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  }
                } catch (err) {
                  return { type: "failed" as const }
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
  }
}
