import { describe, expect, test } from "bun:test"
import { generateKeyPairSync, sign, createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { Auth } from "../../src/auth"
import { NativeChatGPT } from "../../src/plugin/openai/chatgpt"
import { CodexAuthPlugin } from "../../src/plugin/openai/codex"
import { createOpenAI } from "@ai-sdk/openai"
import { tmpdir } from "../fixture/fixture"

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 })
const scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"
const jwt = (claims: object) => {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), keys.privateKey).toString("base64url")}`
}

async function fixture(input: { timeoutMs?: number } = {}) {
  const dir = await tmpdir()
  const codes = new Map<string, URLSearchParams>()
  const observations = {
    tokens: [] as URLSearchParams[],
    requests: [] as { path: string; bearer: string | null; body: unknown }[],
    saves: 0,
  }
  let auth: Auth.Info | undefined
  let identity: Record<string, unknown> = {}
  let tokenFields: Record<string, unknown> = {}
  let inferenceStatus = 200
  let terminal = "response.completed"
  let revocationStatus = 200
  let beforeRefresh: (() => Promise<void>) | undefined
  let beforeRevoke: (() => Promise<void>) | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url)
      const issuer = server.url.origin
      if (url.pathname === "/.well-known/openid-configuration")
        return Response.json({ issuer, jwks_uri: `${issuer}/jwks`, revocation_endpoint: `${issuer}/revoke` })
      if (url.pathname === "/revoke") {
        observations.tokens.push(new URLSearchParams(await request.text()))
        await beforeRevoke?.()
        return new Response(null, { status: revocationStatus })
      }
      if (url.pathname === "/jwks")
        return Response.json({
          keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "test-key", use: "sig", alg: "RS256" }],
        })
      if (url.pathname === "/api/accounts/oauth/token") {
        const form = new URLSearchParams(await request.text())
        observations.tokens.push(form)
        if (form.get("grant_type") === "refresh_token") {
          await beforeRefresh?.()
          return Response.json({
            access_token: "access-renewed",
            refresh_token: "refresh-renewed",
            token_type: "Bearer",
            expires_in: 3600,
            ...tokenFields,
          })
        }
        const params = codes.get(form.get("code")!)
        if (
          !params ||
          form.get("redirect_uri") !== params.get("redirect_uri") ||
          createHash("sha256").update(form.get("code_verifier")!).digest("base64url") !== params.get("code_challenge")
        )
          return Response.json({ error: "invalid_grant" }, { status: 400 })
        return Response.json({
          access_token: "access-initial",
          refresh_token: "refresh-initial",
          token_type: "Bearer",
          expires_in: 3600,
          scope,
          id_token: jwt({
            iss: issuer,
            sub: "account-test",
            aud: form.get("client_id"),
            exp: Date.now() / 1000 + 3600,
            nonce: params.get("nonce"),
            email: "person@example.test",
            ...identity,
          }),
          ...tokenFields,
        })
      }
      if (url.pathname === "/v1/models")
        return Response.json({
          models: [
            { slug: "gpt-test", display_name: "GPT Test", visibility: "list" },
            { slug: "new-server-model", display_name: "New account model", visibility: "list" },
            { slug: "hidden", display_name: "Hidden", visibility: "hide" },
          ],
        })
      const body: unknown = await request.json()
      observations.requests.push({ path: url.pathname, bearer: request.headers.get("authorization"), body })
      if (inferenceStatus !== 200) {
        const status = inferenceStatus
        inferenceStatus = 200
        return Response.json({ error: "unauthorized" }, { status })
      }
      return new Response(`event: ${terminal}\ndata: ${JSON.stringify({ type: terminal })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const options = {
    issuer: server.url.origin,
    apiBase: `${server.url.origin}/v1`,
    registrationPath: path.join(dir.path, "registrations.json"),
    requestTimeoutMs: 1000,
    ...input,
    store: {
      async get() {
        return auth
      },
      async replace(expected: Auth.Oauth, next: Auth.Oauth) {
        if (auth?.type !== "oauth" || auth.access !== expected.access || auth.refresh !== expected.refresh) return false
        observations.saves++
        auth = next
        return true
      },
      async remove(expected: Auth.Oauth) {
        if (auth?.type !== "oauth" || auth.access !== expected.access || auth.refresh !== expected.refresh) return false
        auth = undefined
        return true
      },
    },
  }
  const native = await NativeChatGPT.create(options)
  async function start(registration?: string) {
    if (native.method.type !== "oauth") throw new Error("Expected OAuth")
    const result = await native.method.authorize(registration ? { registration } : undefined)
    if (result.method !== "auto") throw new Error("Expected automatic callback")
    const url = new URL(result.url)
    const code = `code-${codes.size}`
    codes.set(code, url.searchParams)
    return {
      result,
      url,
      async complete(values: Record<string, string> = {}) {
        const callback = new URL(url.searchParams.get("redirect_uri")!)
        callback.search = new URLSearchParams({
          state: url.searchParams.get("state")!,
          code,
          client_id: "oaiapp_cudia_test",
          ...values,
        }).toString()
        const response = await fetch(callback)
        await response.text()
        return { response, result: await result.callback() }
      },
    }
  }
  return {
    native,
    options,
    observations,
    start,
    get auth() {
      return auth
    },
    set auth(value: Auth.Info | undefined) {
      auth = value
    },
    set identity(value: Record<string, unknown>) {
      identity = value
    },
    set tokenFields(value: Record<string, unknown>) {
      tokenFields = value
    },
    set inferenceStatus(value: number) {
      inferenceStatus = value
    },
    set terminal(value: string) {
      terminal = value
    },
    set revocationStatus(value: number) {
      revocationStatus = value
    },
    set beforeRefresh(value: () => Promise<void>) {
      beforeRefresh = value
    },
    set beforeRevoke(value: () => Promise<void>) {
      beforeRevoke = value
    },
    async accept() {
      const result = (await (await start()).complete()).result
      if (result.type !== "success" || !("refresh" in result)) throw new Error("Expected OAuth success")
      auth = { ...result, type: "oauth" }
      if (!NativeChatGPT.isNative(auth)) throw new Error("Native metadata was not preserved")
      return auth
    },
    async [Symbol.asyncDispose]() {
      native.dispose()
      await server.stop(true)
      await dir[Symbol.asyncDispose]()
    },
  }
}

describe("native ChatGPT OAuth", () => {
  test("registers CUDIA with PKCE, verifies signed identity and preserves metadata", async () => {
    await using f = await fixture()
    const login = await f.start()
    expect(login.url.pathname).toBe("/api/accounts/authorize")
    expect(login.url.searchParams.get("client_id")).toBe("dynamic_agent_client")
    expect(login.url.searchParams.get("agent_name_hint")).toBe("CUDIA")
    expect(login.url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(new URL(login.url.searchParams.get("redirect_uri")!).hostname).toBe("127.0.0.1")
    const result = (await login.complete()).result
    expect(result.type).toBe("success")
    expect(f.observations.tokens[0]!.get("client_id")).toBe("oaiapp_cudia_test")
    expect(f.observations.tokens[0]!.get("resource")).toBe("https://api.openai.com/v1")
    if (result.type !== "success" || !("refresh" in result)) throw new Error("Expected OAuth result")
    const decoded = Auth.Oauth.make({ ...result, type: "oauth" })
    expect(decoded.metadata?.oauthMode).toBe("chatgpt")
    expect(decoded.metadata?.clientId).toBe("oaiapp_cudia_test")
    expect(decoded.metadata?.subject).toBe("account-test")
    const saved = JSON.parse(await readFile(f.options.registrationPath, "utf8"))
    expect(saved.hostId).toBe(login.url.searchParams.get("ext_agent_host_id"))
    expect(saved.registrations[0].subject).toBe("account-test")
    expect(JSON.stringify(saved)).not.toContain("access-initial")
  })

  test("a wrong-state error cannot cancel either of two concurrent logins", async () => {
    await using f = await fixture()
    const first = await f.start()
    const second = await f.start()
    expect(first.url.searchParams.get("redirect_uri")).not.toBe(second.url.searchParams.get("redirect_uri"))
    expect(first.url.searchParams.get("ext_agent_host_id")).toBe(second.url.searchParams.get("ext_agent_host_id"))
    const wrong = new URL(first.url.searchParams.get("redirect_uri")!)
    wrong.search = "state=wrong&error=access_denied"
    const response = await fetch(wrong)
    expect(response.status).toBe(400)
    await response.text()
    expect((await first.complete()).result.type).toBe("success")
    expect((await second.complete()).result.type).toBe("success")
  })

  test("valid-state denial terminates immediately and closes its listener", async () => {
    await using f = await fixture()
    const login = await f.start()
    const url = new URL(login.url.searchParams.get("redirect_uri")!)
    url.search = new URLSearchParams({ state: login.url.searchParams.get("state")!, error: "access_denied" }).toString()
    await (await fetch(url)).text()
    await expect(login.result.callback()).rejects.toThrow("access_denied")
    await expect(fetch(url)).rejects.toThrow()
    expect(f.observations.tokens).toHaveLength(0)
  })

  test("a changed JWT signature cannot establish an identity", async () => {
    await using f = await fixture()
    const login = await f.start()
    const token = jwt({
      iss: f.options.issuer,
      sub: "account-test",
      aud: "oaiapp_cudia_test",
      nonce: login.url.searchParams.get("nonce"),
      exp: Date.now() / 1000 + 3600,
    })
    const parts = token.split(".")
    parts[2] = (parts[2]![0] === "A" ? "B" : "A") + parts[2]!.slice(1)
    f.tokenFields = { id_token: parts.join(".") }
    await expect(login.complete()).rejects.toThrow("signature")
    expect(f.auth).toBeUndefined()
  })

  test.each([
    ["nonce", { nonce: "wrong" }],
    ["audience", { aud: "other-client" }],
    ["issuer", { iss: "https://another.example" }],
    ["expiration", { exp: 1 }],
  ])("rejects wrong %s without replacing the active credentials", async (_, claims) => {
    await using f = await fixture()
    const current: Auth.Info = { type: "api", key: "working-key" }
    f.auth = current
    f.identity = claims
    const login = await f.start()
    await expect(login.complete()).rejects.toThrow()
    expect(f.auth).toBe(current)
    expect(f.observations.saves).toBe(0)
  })

  test("requires a renewable token and plan scopes before accepting login", async () => {
    await using f = await fixture()
    f.tokenFields = { scope: "openid profile email" }
    await expect((await f.start()).complete()).rejects.toThrow("plan usage")
    f.tokenFields = { refresh_token: null }
    await expect((await f.start()).complete()).rejects.toThrow()
  })

  test("cancellation and deadlines close their own loopback listeners", async () => {
    await using f = await fixture({ timeoutMs: 150 })
    const cancelled = await f.start()
    const cancel = new URL(cancelled.url.searchParams.get("redirect_uri")!)
    cancel.pathname = "/cancel"
    cancel.searchParams.set("state", cancelled.url.searchParams.get("state")!)
    await fetch(cancel).catch(() => undefined)
    await expect(cancelled.result.callback()).rejects.toThrow("cancelled")
    await expect(fetch(cancel)).rejects.toThrow()
    const expired = await f.start()
    await expect(expired.result.callback()).rejects.toThrow("timed out")
    await expect(fetch(expired.url.searchParams.get("redirect_uri")!)).rejects.toThrow()
  })

  test("reauthorizes the issued registration and rejects a different subject", async () => {
    await using f = await fixture()
    const auth = await f.accept()
    f.identity = { sub: "another-account" }
    const login = await f.start(auth.metadata.clientId)
    expect(login.url.searchParams.get("client_id")).toBe(auth.metadata.clientId)
    expect(login.url.searchParams.has("agent_name_hint")).toBe(false)
    await expect(login.complete()).rejects.toThrow("identity mismatch")
    expect(f.auth).toBe(auth)
  })

  test("refreshes through the issued client ID once across two native loaders", async () => {
    await using f = await fixture()
    const initial = await f.accept()
    f.auth = { ...initial, expires: 1 }
    const other = await NativeChatGPT.create(f.options)
    const first = await f.native.loader(async () => f.auth)
    const second = await other.loader(async () => f.auth)
    try {
      const responses = await Promise.all(
        [first, second].map((loader) =>
          loader.fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            body: JSON.stringify({ model: "gpt-test", input: [{ role: "user", content: "hello" }] }),
          }),
        ),
      )
      await Promise.all(responses.map((response) => response.text()))
      expect(f.observations.tokens.filter((form) => form.get("grant_type") === "refresh_token")).toHaveLength(1)
      expect(f.observations.tokens.at(-1)!.get("client_id")).toBe("oaiapp_cudia_test")
      expect(f.observations.saves).toBe(1)
      expect(f.observations.requests.map((request) => request.bearer)).toEqual([
        "Bearer access-renewed",
        "Bearer access-renewed",
      ])
    } finally {
      other.dispose()
    }
  })

  test("one HTTP 401 renews and replays; a failed stream is never replayed", async () => {
    await using f = await fixture()
    await f.accept()
    const loader = await f.native.loader(async () => f.auth)
    const run = () =>
      loader.fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        body: JSON.stringify({ model: "gpt-test", input: [] }),
      })
    f.inferenceStatus = 401
    await (await run()).text()
    expect(f.observations.requests).toHaveLength(2)
    expect(f.observations.saves).toBe(1)
    f.terminal = "response.failed"
    await expect((await run()).text()).rejects.toThrow("failed")
    expect(f.observations.requests).toHaveLength(3)
  })

  test("refresh cannot restore or use credentials removed while tokens were renewed", async () => {
    await using f = await fixture()
    f.auth = { ...(await f.accept()), expires: 1 }
    f.beforeRefresh = async () => {
      f.auth = undefined
    }
    const loader = await f.native.loader(async () => f.auth)
    await expect(
      loader.fetch("https://api.openai.com/v1/responses", { method: "POST", body: JSON.stringify({ input: [] }) }),
    ).rejects.toThrow("changed while saving")
    expect(f.auth).toBeUndefined()
    expect(f.observations.requests).toHaveLength(0)
  })

  test("logout preserves a successful concurrent reconnect", async () => {
    await using f = await fixture()
    const auth = await f.accept()
    f.beforeRevoke = async () => {
      f.auth = { type: "api", key: "reconnected-key" }
    }
    await expect(NativeChatGPT.logout(auth, f.options)).rejects.toThrow("active account changed")
    expect(f.auth).toEqual({ type: "api", key: "reconnected-key" })
  })

  test.each([200, 500])("logout removes local tokens and reports revocation status %s accurately", async (status) => {
    await using f = await fixture()
    const auth = await f.accept()
    f.revocationStatus = status
    const result = await NativeChatGPT.logout(auth, f.options)
    expect(result.removed).toBe(true)
    expect(result.revoked).toBe(status === 200)
    expect(f.auth).toBeUndefined()
    const request = f.observations.tokens.at(-1)!
    expect(request.get("client_id")).toBe(auth.metadata.clientId)
    expect(request.get("token")).toBe(auth.refresh)
    expect(request.get("token_type_hint")).toBe("refresh_token")
    expect(JSON.parse(await readFile(f.options.registrationPath, "utf8")).registrations).toHaveLength(1)
  })

  test("the real OpenAI SDK preserves instructions and tool names on the native route", async () => {
    await using f = await fixture()
    await f.accept()
    const loader = await f.native.loader(async () => f.auth)
    const model = createOpenAI({ apiKey: loader.apiKey, fetch: loader.fetch as typeof fetch }).responses("gpt-test")
    f.inferenceStatus = 400
    await expect(
      model.doGenerate({
        prompt: [
          { role: "system", content: "operator setup unchanged" },
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        tools: [
          {
            type: "function",
            name: "echo",
            description: "Echo supplied input",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    ).rejects.toThrow()
    const sent = f.observations.requests[0]!
    expect(sent.path).toBe("/v1/responses")
    const payload = sent.body as Record<string, unknown>
    expect(payload.stream).toBe(true)
    expect(payload.store).toBe(false)
    expect(JSON.stringify(payload.input)).toContain("operator setup unchanged")
    expect(JSON.stringify(payload.input)).toContain('"type":"additional_tools"')
    expect(JSON.stringify(payload.input)).toContain('"name":"echo"')
  })

  test("uses the account model catalog and routes native inference separately from legacy", async () => {
    await using f = await fixture()
    const auth = await f.accept()
    const hooks = await CodexAuthPlugin({} as never, {
      chatgpt: f.options,
      codexApiEndpoint: `${f.options.apiBase}/legacy`,
    })
    const provider = {
      models: {
        "gpt-test": {
          id: "gpt-test",
          api: { id: "gpt-test", npm: "@ai-sdk/openai" },
          options: {},
          limit: { context: 10000, output: 1000 },
        },
      },
    }
    try {
      const models = await hooks.provider!.models!(provider as never, { auth })
      expect(Object.keys(models)).toEqual(["gpt-test", "new-server-model"])
      expect(models["new-server-model"]!.name).toBe("New account model")
      const native = await hooks.auth!.loader!(async () => auth, provider as never)
      await (
        await native.fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ input: [] }),
        })
      ).text()
      const legacyAuth = {
        type: "oauth" as const,
        access: "legacy-access",
        refresh: "legacy-refresh",
        expires: Date.now() + 3600000,
      }
      const legacy = await hooks.auth!.loader!(async () => legacyAuth, provider as never)
      await (
        await legacy.fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          body: JSON.stringify({ input: [] }),
        })
      ).text()
      expect(f.observations.requests.map((request) => request.path)).toEqual(["/v1/responses", "/v1/legacy"])
    } finally {
      await hooks.dispose?.()
    }
  })

  test("adapts preview transport without changing instructions or function names", () => {
    const original = {
      model: "model",
      instructions: "user-selected instruction",
      input: [{ role: "system", content: "original" }],
      tools: [{ type: "function", name: "shell", parameters: {} }],
      temperature: 0.1,
      max_output_tokens: 2000,
      previous_response_id: "old",
    }
    const result = NativeChatGPT.adaptRequest(original)
    expect(result.instructions).toBe(original.instructions)
    expect(result.input).toEqual([
      { type: "additional_tools", role: "developer", tools: original.tools },
      { role: "developer", content: "original" },
    ])
    expect(result.temperature).toBeUndefined()
    expect(result.previous_response_id).toBeUndefined()
    expect(result.store).toBe(false)
    expect(result.stream).toBe(true)
    expect(original.max_output_tokens).toBe(2000)
  })

  test("EOF and incomplete events cannot be reported as completed inference", async () => {
    const response = (type: string) => new Response(`data: ${JSON.stringify({ type })}\n\n`)
    await expect(NativeChatGPT.guardResponse(response("response.output_text.delta")).text()).rejects.toThrow(
      "without response.completed",
    )
    await expect(NativeChatGPT.guardResponse(response("response.incomplete")).text()).rejects.toThrow("incomplete")
    expect(await NativeChatGPT.guardResponse(response("response.completed")).text()).toContain("response.completed")
  })

  test("SSE verification preserves split UTF-8 and split event boundaries", async () => {
    const source =
      'data: {"type":"response.output_text.delta","delta":"á漢"}\r\n\r\ndata: {"type":"response.completed"}\r\n\r\n'
    const bytes = new TextEncoder().encode(source)
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
        controller.close()
      },
    })
    expect(await NativeChatGPT.guardResponse(new Response(body)).text()).toBe(source)
  })

  test("malformed native metadata cannot select the legacy transport", async () => {
    await using f = await fixture()
    const auth = await f.accept()
    const hooks = await CodexAuthPlugin({} as never, { chatgpt: f.options })
    try {
      await expect(
        hooks.auth!.loader!(
          async () => ({ ...auth, metadata: { ...auth.metadata, clientId: "dynamic_agent_client" } }),
          {} as never,
        ),
      ).rejects.toThrow()
      expect(f.observations.requests).toHaveLength(0)
    } finally {
      await hooks.dispose?.()
    }
  })
})
