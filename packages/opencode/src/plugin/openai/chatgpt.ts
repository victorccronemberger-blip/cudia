import type { AuthOAuthResult, Hooks } from "@opencode-ai/plugin"
import { Auth, OAUTH_DUMMY_KEY } from "../../auth"
import { Global } from "@opencode-ai/core/global"
import { Flock } from "@opencode-ai/core/util/flock"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { createServer } from "node:http"
import { randomBytes, randomUUID, createHash } from "node:crypto"
import { mkdir, open, readFile, rename, rm } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

const ISSUER = "https://auth.openai.com"
const RESOURCE = "https://api.openai.com/v1"
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
const BootstrapClient = "dynamic_agent_client"
const Metadata = z.object({
  oauthMode: z.literal("chatgpt"),
  clientId: z
    .string()
    .min(1)
    .refine((value) => value !== BootstrapClient),
  subject: z.string().min(1),
  hostId: z.string().min(1),
  scopes: z.string(),
  idToken: z.string().min(1),
  email: z.string().optional(),
})
const Registration = z.object({
  clientId: z.string().min(1),
  subject: z.string().optional(),
  email: z.string().optional(),
})
const Registrations = z.object({ hostId: z.string().min(1), registrations: z.array(Registration) })
const Token = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  id_token: z.string().min(1).optional(),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z
    .number()
    .int()
    .positive()
    .refine((value) => Number.isSafeInteger(Date.now() + value * 1000)),
  scope: z.string().optional(),
})
type NativeAuth = Auth.Oauth & { metadata: z.infer<typeof Metadata> }
type ModelHook = NonNullable<NonNullable<Hooks["provider"]>["models"]>

export interface Options {
  issuer?: string
  apiBase?: string
  registrationPath?: string
  timeoutMs?: number
  requestTimeoutMs?: number
  store?: {
    get(): Promise<Auth.Info | undefined>
    replace(expected: Auth.Oauth, next: Auth.Oauth): Promise<boolean>
    remove?(expected: Auth.Oauth): Promise<boolean>
  }
}

export function isNative(auth: unknown): auth is NativeAuth {
  if (
    typeof auth !== "object" ||
    auth === null ||
    !("metadata" in auth) ||
    !auth.metadata ||
    typeof auth.metadata !== "object" ||
    !("oauthMode" in auth.metadata) ||
    auth.metadata.oauthMode !== "chatgpt"
  )
    return false
  Metadata.parse(auth.metadata)
  z.object({
    type: z.literal("oauth"),
    access: z.string().trim().min(1),
    refresh: z.string().trim().min(1),
    expires: z.number().int().nonnegative(),
  }).parse(auth)
  return true
}

async function json(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty OAuth response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.byteLength
      if (size > 2 * 1024 * 1024) throw new Error("OAuth response exceeds 2 MiB")
      chunks.push(item.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

// Only signed identity claims are used for registration. Decoding a JWT is not verification.
export async function verifyIdentity(
  token: string,
  input: {
    issuer: string
    clientId: string
    nonce?: string
    subject?: string
    signal: AbortSignal
  },
) {
  const parts = token.split(".")
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
    throw new Error("Invalid ChatGPT ID token")
  const header = z
    .object({ alg: z.literal("RS256"), kid: z.string().min(1), crit: z.never().optional() })
    .parse(JSON.parse(Buffer.from(parts[0], "base64url").toString()))
  const discoveryResponse = await fetch(`${input.issuer}/.well-known/openid-configuration`, {
    signal: input.signal,
    redirect: "error",
  })
  if (!discoveryResponse.ok) throw new Error(`ChatGPT discovery failed (${discoveryResponse.status})`)
  const discovery = z.object({ issuer: z.string(), jwks_uri: z.string().url() }).parse(await json(discoveryResponse))
  if (discovery.issuer !== input.issuer || new URL(discovery.jwks_uri).origin !== new URL(input.issuer).origin)
    throw new Error("ChatGPT discovery issuer/JWKS mismatch")
  const response = await fetch(discovery.jwks_uri, { signal: input.signal, redirect: "error" })
  if (!response.ok) throw new Error(`ChatGPT signing keys unavailable (${response.status})`)
  const keys = z
    .object({
      keys: z.array(
        z.object({
          kid: z.string(),
          kty: z.literal("RSA"),
          n: z.string(),
          e: z.string(),
          alg: z.literal("RS256").optional(),
          use: z.literal("sig").optional(),
        }),
      ),
    })
    .parse(await json(response))
  const key = keys.keys.filter((item) => item.kid === header.kid)
  if (key.length !== 1) throw new Error("ChatGPT ID token signing key unavailable")
  const imported = await crypto.subtle.importKey("jwk", key[0], { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
    "verify",
  ])
  if (
    !(await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      imported,
      Buffer.from(parts[2], "base64url"),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    ))
  )
    throw new Error("Invalid ChatGPT ID token signature")
  const claims = z
    .object({
      iss: z.literal(input.issuer),
      sub: z.string().min(1),
      aud: z.union([z.string(), z.array(z.string()).min(1)]),
      exp: z.number().finite(),
      iat: z.number().finite().optional(),
      nbf: z.number().finite().optional(),
      nonce: z.string().optional(),
      azp: z.string().optional(),
      email: z.string().optional(),
    })
    .parse(JSON.parse(Buffer.from(parts[1], "base64url").toString()))
  const audiences = typeof claims.aud === "string" ? [claims.aud] : claims.aud
  const now = Date.now() / 1000
  if (
    !audiences.includes(input.clientId) ||
    (audiences.length > 1 && claims.azp !== input.clientId) ||
    (claims.azp && claims.azp !== input.clientId) ||
    claims.exp <= now ||
    (claims.nbf !== undefined && claims.nbf > now + 30) ||
    (claims.iat !== undefined && claims.iat > now + 30) ||
    (input.nonce !== undefined && claims.nonce !== input.nonce) ||
    (input.subject !== undefined && claims.sub !== input.subject)
  )
    throw new Error("ChatGPT ID token identity mismatch")
  return claims
}

function planScopes(scope: string) {
  const granted = new Set(scope.split(/\s+/).filter(Boolean))
  if (
    !["openid", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"].every((value) => granted.has(value))
  )
    throw new Error("ChatGPT plan usage was not granted; reconnect and enable plan usage")
}

export async function create(options: Options = {}) {
  const issuer = options.issuer ?? ISSUER
  const apiBase = options.apiBase ?? RESOURCE
  const registrationPath = options.registrationPath ?? path.join(Global.Path.data, "chatgpt-registration.json")
  const store = options.store ?? {
    get: async () => (await Auth.readStored()).openai,
    replace: (expected: Auth.Oauth, next: Auth.Oauth) => Auth.replaceStored("openai", expected, next),
  }
  const pending = new Set<AbortController>()
  const signalFor = (signal?: AbortSignal) =>
    signal
      ? AbortSignal.any([signal, AbortSignal.timeout(options.requestTimeoutMs ?? 30_000)])
      : AbortSignal.timeout(options.requestTimeoutMs ?? 30_000)
  async function registrations() {
    return readFile(registrationPath, "utf8")
      .then((text) => Registrations.parse(JSON.parse(text)))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
  }
  async function saveRegistration(update: (current: z.infer<typeof Registrations>) => z.infer<typeof Registrations>) {
    return Flock.withLock(
      `chatgpt-registration:${registrationPath}`,
      async () => {
        const data = update((await registrations()) ?? { hostId: `urn:uuid:${randomUUID()}`, registrations: [] })
        await mkdir(path.dirname(registrationPath), { recursive: true })
        const temporary = `${registrationPath}.${randomUUID()}.tmp`
        const handle = await open(temporary, "wx", 0o600)
        try {
          await handle.writeFile(JSON.stringify(data))
          await handle.sync()
          await handle.close()
          await rename(temporary, registrationPath)
        } finally {
          await handle.close().catch(() => {})
          await rm(temporary, { force: true })
        }
        return data
      },
      { timeoutMs: 30_000 },
    )
  }
  async function tokens(body: URLSearchParams, signal?: AbortSignal) {
    const response = await fetch(`${issuer}/api/accounts/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: signalFor(signal),
      redirect: "error",
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`ChatGPT token exchange failed (${response.status}); reconnect if the session was revoked`)
    }
    return Token.parse(await json(response))
  }
  async function refresh(expected: NativeAuth, force: boolean, signal?: AbortSignal): Promise<NativeAuth> {
    return Flock.withLock(
      `chatgpt-refresh:${registrationPath}:${expected.metadata.clientId}`,
      async () => {
        signal?.throwIfAborted()
        const current = await store.get()
        if (
          !isNative(current) ||
          current.metadata.clientId !== expected.metadata.clientId ||
          current.metadata.subject !== expected.metadata.subject
        )
          throw new Error("ChatGPT account changed during the request; submit again with the selected account")
        if (current.access !== expected.access || current.refresh !== expected.refresh) return current
        if (!force && current.expires > Date.now() + 60_000) return current
        const result = await tokens(
          new URLSearchParams({
            grant_type: "refresh_token",
            client_id: current.metadata.clientId,
            refresh_token: current.refresh,
            resource: RESOURCE,
          }),
          signal,
        )
        const scopes = result.scope ?? current.metadata.scopes
        planScopes(scopes)
        if (result.id_token)
          await verifyIdentity(result.id_token, {
            issuer,
            clientId: current.metadata.clientId,
            subject: current.metadata.subject,
            signal: signalFor(signal),
          })
        const next: NativeAuth = {
          ...current,
          access: result.access_token,
          refresh: result.refresh_token ?? current.refresh,
          expires: Date.now() + result.expires_in * 1000,
          metadata: { ...current.metadata, scopes, idToken: result.id_token ?? current.metadata.idToken },
        }
        if (!(await store.replace(current, next)))
          throw new Error("ChatGPT credentials changed while saving the renewed session")
        return next
      },
      { signal, timeoutMs: 45_000 },
    )
  }
  async function request(auth: NativeAuth, url: string, init: RequestInit = {}) {
    let active = auth.expires <= Date.now() + 60_000 ? await refresh(auth, false, init.signal ?? undefined) : auth
    const send = () => {
      const headers = new Headers(init.headers)
      headers.set("authorization", `Bearer ${active.access}`)
      return fetch(url, { ...init, headers, redirect: "error" })
    }
    const response = await send()
    if (response.status !== 401) return response
    await response.body?.cancel()
    active = await refresh(active, true, init.signal ?? undefined)
    return send()
  }
  const saved = await registrations()
  const method: NonNullable<Hooks["auth"]>["methods"][number] = {
    type: "oauth",
    label: "Continue with ChatGPT",
    ...(saved?.registrations.length
      ? {
          prompts: [
            {
              type: "select" as const,
              key: "registration",
              message: "ChatGPT account",
              options: [
                ...saved.registrations.map((entry) => ({
                  label: `${entry.email ?? entry.subject ?? "Pending registration"} (${entry.clientId})`,
                  value: entry.clientId,
                })),
                { label: "Add another ChatGPT account", value: "new" },
              ],
            },
          ],
        }
      : {}),
    async authorize(inputs) {
      const records = await saveRegistration((current) => current)
      const selected =
        inputs?.registration && inputs.registration !== "new"
          ? records.registrations.find((entry) => entry.clientId === inputs.registration)
          : undefined
      if (inputs?.registration && inputs.registration !== "new" && !selected)
        throw new Error("Unknown ChatGPT registration")
      const clientId = selected?.clientId ?? BootstrapClient
      const pkce = randomBytes(32).toString("base64url")
      const state = randomBytes(32).toString("base64url")
      const nonce = randomBytes(32).toString("base64url")
      const controller = new AbortController()
      pending.add(controller)
      const deferred = Promise.withResolvers<Auth.Oauth>()
      deferred.promise.catch(() => {})
      let claimed = false
      let redirectUri = ""
      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", redirectUri)
        if (
          req.method !== "GET" ||
          req.headers.host !== new URL(redirectUri).host ||
          !["/auth/callback", "/cancel"].includes(url.pathname)
        ) {
          res.writeHead(404).end()
          return
        }
        if (url.searchParams.get("state") !== state || claimed) {
          res.writeHead(400).end("Invalid or already used OAuth state")
          return
        }
        claimed = true
        if (url.pathname === "/cancel") {
          res.writeHead(200).end("Login cancelled")
          controller.abort(new Error("ChatGPT login cancelled"))
          return
        }
        try {
          if (url.searchParams.has("error"))
            throw new Error(url.searchParams.get("error_description") ?? url.searchParams.get("error")!)
          const code = url.searchParams.get("code")
          const issued = url.searchParams.get("client_id") ?? selected?.clientId
          if (!code || !issued || issued === BootstrapClient || (selected && issued !== selected.clientId))
            throw new Error("ChatGPT authorization did not return the expected issued client ID/code")
          const registered = await saveRegistration((current) => ({
            ...current,
            registrations: [
              ...current.registrations.filter((entry) => entry.clientId !== issued),
              current.registrations.find((entry) => entry.clientId === issued) ?? selected ?? { clientId: issued },
            ],
          }))
          const result = await tokens(
            new URLSearchParams({
              grant_type: "authorization_code",
              client_id: issued,
              code,
              code_verifier: pkce,
              redirect_uri: redirectUri,
              resource: RESOURCE,
            }),
            controller.signal,
          )
          if (!result.id_token || !result.refresh_token || !result.scope)
            throw new Error("Incomplete ChatGPT credential response")
          const identity = await verifyIdentity(result.id_token, {
            issuer,
            clientId: issued,
            nonce,
            subject: registered.registrations.find((entry) => entry.clientId === issued)?.subject,
            signal: signalFor(controller.signal),
          })
          planScopes(result.scope)
          await saveRegistration((current) => ({
            ...current,
            registrations: [
              ...current.registrations.filter((entry) => entry.clientId !== issued),
              { clientId: issued, subject: identity.sub, ...(identity.email ? { email: identity.email } : {}) },
            ],
          }))
          controller.signal.throwIfAborted()
          const auth: NativeAuth = {
            type: "oauth",
            access: result.access_token,
            refresh: result.refresh_token,
            expires: Date.now() + result.expires_in * 1000,
            metadata: {
              oauthMode: "chatgpt",
              clientId: issued,
              subject: identity.sub,
              hostId: records.hostId,
              scopes: result.scope,
              idToken: result.id_token,
              ...(identity.email ? { email: identity.email } : {}),
            },
          }
          res
            .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
            .end(OauthCallbackPage.success({ provider: "ChatGPT" }))
          deferred.resolve(auth)
        } catch (error) {
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(
            OauthCallbackPage.error(error instanceof Error ? error.message : "ChatGPT login failed", {
              provider: "ChatGPT",
            }),
          )
          deferred.reject(error)
        } finally {
          close()
        }
      })
      const close = () => {
        clearTimeout(deadline)
        pending.delete(controller)
        server.close()
        server.closeIdleConnections()
      }
      const deadline = setTimeout(
        () => controller.abort(new Error("ChatGPT login timed out")),
        options.timeoutMs ?? 15 * 60_000,
      )
      controller.signal.addEventListener(
        "abort",
        () => {
          deferred.reject(controller.signal.reason)
          close()
          server.closeAllConnections()
        },
        { once: true },
      )
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject)
          server.listen(0, "127.0.0.1", resolve)
        })
      } catch (error) {
        close()
        throw error
      }
      const address = server.address()
      if (!address || typeof address === "string") {
        close()
        throw new Error("ChatGPT loopback listener unavailable")
      }
      redirectUri = `http://127.0.0.1:${address.port}/auth/callback`
      const params = new URLSearchParams({
        client_id: clientId,
        ext_agent_host_id: records.hostId,
        response_type: "code",
        redirect_uri: redirectUri,
        scope: SCOPES,
        resource: RESOURCE,
        state,
        nonce,
        code_challenge_method: "S256",
        code_challenge: createHash("sha256").update(pkce).digest("base64url"),
        ...(selected ? {} : { agent_name_hint: "CUDIA" }),
      })
      return {
        url: `${issuer}/api/accounts/authorize?${params}`,
        method: "auto",
        instructions:
          "Authorize CUDIA and ChatGPT plan usage in your browser. The connection is saved only after identity verification.",
        async callback() {
          const { type, ...credentials } = await deferred.promise
          return { type: "success", ...credentials }
        },
      } satisfies AuthOAuthResult
    },
  }
  return {
    method,
    dispose() {
      for (const controller of pending) controller.abort(new Error("ChatGPT login closed"))
    },
    async loader(getAuth: () => Promise<unknown>) {
      return {
        apiKey: OAUTH_DUMMY_KEY,
        async fetch(input: RequestInfo | URL, init?: RequestInit) {
          const auth = await getAuth()
          if (!isNative(auth)) throw new Error("ChatGPT authentication changed; reconnect the selected provider")
          const original = new Request(input, init)
          const body: unknown = await original.json()
          const payload = adaptRequest(body)
          const headers = new Headers(original.headers)
          headers.delete("chatgpt-account-id")
          headers.delete("x-openai-internal-codex-residency")
          headers.set("content-type", "application/json")
          const response = await request(auth, `${apiBase}/responses`, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
            signal: original.signal,
          })
          return guardResponse(response)
        },
      }
    },
    async models(provider: Parameters<ModelHook>[0], auth: NativeAuth) {
      const response = await request(auth, `${apiBase}/models`, { signal: signalFor() })
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`ChatGPT model catalog unavailable (${response.status})`)
      }
      const catalog = z
        .object({
          models: z.array(z.object({ slug: z.string().min(1), display_name: z.string(), visibility: z.string() })),
        })
        .parse(await json(response))
      const fallback = Object.values(provider.models).find((model) => model.api.npm === "@ai-sdk/openai")
      return Object.fromEntries(
        catalog.models
          .filter((model) => model.visibility === "list")
          .flatMap((entry) => {
            const existing = provider.models[entry.slug]
            const model = existing ?? fallback
            if (!model) return []
            return [
              [
                entry.slug,
                {
                  ...model,
                  id: entry.slug,
                  name: entry.display_name,
                  api: { ...model.api, id: entry.slug, url: apiBase, npm: "@ai-sdk/openai" },
                  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                  // Unknown models get conservative local estimates until catalog metadata is supplied.
                  ...(existing ? {} : { limit: { context: 8192, output: 4096 } }),
                },
              ],
            ]
          }),
      )
    },
  }
}

export function adaptRequest(input: unknown): Record<string, unknown> & { store: false; stream: true } {
  const body = z.record(z.string(), z.unknown()).parse(input)
  for (const key of [
    "background",
    "conversation",
    "max_output_tokens",
    "max_tool_calls",
    "metadata",
    "moderation",
    "multi_agent",
    "prompt",
    "prompt_cache_retention",
    "safety_identifier",
    "temperature",
    "top_logprobs",
    "top_p",
    "truncation",
    "user",
    "previous_response_id",
  ])
    delete body[key]
  const messages = Array.isArray(body.input) ? body.input : [{ role: "user", content: body.input }]
  body.input = messages.map((item) => {
    if (typeof item !== "object" || item === null || !("role" in item) || item.role !== "system") return item
    return { ...item, role: "developer" }
  })
  // Additional-tools items preserve function names and tool-choice identifiers;
  // no hosted search/MCP tool or extra system instruction is introduced here.
  if (Array.isArray(body.tools)) {
    const local = body.tools.filter((tool) => tool && ["function", "custom"].includes(tool.type))
    body.tools = body.tools.filter((tool) => !tool || !["function", "custom"].includes(tool.type))
    if (local.length)
      body.input = [{ type: "additional_tools", role: "developer", tools: local }, ...(body.input as unknown[])]
  }
  return { ...body, store: false, stream: true }
}

export function guardResponse(response: Response) {
  if (!response.ok || !response.body) return response
  const decoder = new TextDecoder()
  let buffered = ""
  let completed = false
  let failed = false
  function inspect(final = false) {
    const frames = buffered.split(/\r?\n\r?\n/)
    buffered = final ? "" : (frames.pop() ?? "")
    for (const frame of frames) {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
      if (!data || data === "[DONE]") continue
      const event = JSON.parse(data) as { type?: string }
      if (event.type === "response.completed") completed = true
      if (["response.failed", "response.incomplete", "error"].includes(event.type ?? "")) failed = true
    }
    if (buffered.length > 2 * 1024 * 1024) throw new Error("ChatGPT SSE event exceeds 2 MiB")
  }
  return new Response(
    response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffered += decoder.decode(chunk, { stream: true })
          inspect()
          controller.enqueue(chunk)
        },
        flush() {
          buffered += decoder.decode()
          inspect(true)
          if (failed || !completed)
            throw new Error(
              failed ? "ChatGPT response failed or was incomplete" : "ChatGPT stream ended without response.completed",
            )
        },
      }),
    ),
    { status: response.status, statusText: response.statusText, headers: response.headers },
  )
}

export async function revoke(auth: Auth.Oauth, options: Pick<Options, "issuer" | "requestTimeoutMs"> = {}) {
  if (!isNative(auth)) return
  const issuer = options.issuer ?? ISSUER
  const signal = AbortSignal.timeout(options.requestTimeoutMs ?? 30_000)
  const discovery = await fetch(`${issuer}/.well-known/openid-configuration`, { signal, redirect: "error" })
  if (!discovery.ok) throw new Error(`ChatGPT revocation discovery failed (${discovery.status})`)
  const metadata = z
    .object({ issuer: z.literal(issuer), revocation_endpoint: z.string().url() })
    .parse(await json(discovery))
  if (new URL(metadata.revocation_endpoint).origin !== new URL(issuer).origin)
    throw new Error("ChatGPT revocation issuer mismatch")
  const response = await fetch(metadata.revocation_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal,
    redirect: "error",
    body: new URLSearchParams({
      client_id: auth.metadata.clientId,
      token: auth.refresh,
      token_type_hint: "refresh_token",
    }),
  })
  await response.body?.cancel()
  if (!response.ok) throw new Error(`ChatGPT session revocation failed (${response.status})`)
}

export async function logout(expected: Auth.Oauth, options: Options = {}) {
  if (!isNative(expected)) throw new Error("Invalid native ChatGPT credentials")
  if (options.store && !options.store.remove) throw new Error("ChatGPT credential store cannot remove a session")
  const registrationPath = options.registrationPath ?? path.join(Global.Path.data, "chatgpt-registration.json")
  return Flock.withLock(
    `chatgpt-refresh:${registrationPath}:${expected.metadata.clientId}`,
    async () => {
      const current = options.store ? await options.store.get() : (await Auth.readStored()).openai
      if (
        !isNative(current) ||
        current.metadata.clientId !== expected.metadata.clientId ||
        current.metadata.subject !== expected.metadata.subject
      )
        throw new Error("The active account changed during sign-out; its credentials were preserved")
      const revocationError = await revoke(current, options).then(
        () => undefined,
        (error: unknown) => error,
      )
      const removed = options.store?.remove
        ? await options.store.remove(current)
        : await Auth.mutateStored((data) => {
            const active = data.openai
            if (
              active?.type !== "oauth" ||
              active.access !== current.access ||
              active.refresh !== current.refresh ||
              active.metadata?.clientId !== current.metadata.clientId ||
              active.metadata?.subject !== current.metadata.subject
            )
              return
            delete data.openai
            return data
          })
      if (!removed) throw new Error("The active account changed during sign-out; its credentials were preserved")
      return { removed: true, revoked: revocationError === undefined, revocationError }
    },
    { timeoutMs: 45_000 },
  )
}

export * as NativeChatGPT from "./chatgpt"
