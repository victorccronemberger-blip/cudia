import { describe, expect, test } from "bun:test"
import { createXai } from "@ai-sdk/xai"
import { accessTokenIsExpiring, pollDeviceCodeToken, requestDeviceCode, XaiAuthPlugin } from "../../src/plugin/xai"
import { OAUTH_DUMMY_KEY } from "../../src/auth"

function makeJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

function makeInput(opts?: { failSet?: boolean; returnSetError?: boolean; onSet?: () => void }) {
  const setCalls: Array<Record<string, unknown>> = []
  return {
    input: {
      client: {
        auth: {
          set: async (req: Record<string, unknown>) => {
            setCalls.push(req)
            opts?.onSet?.()
            if (opts?.failSet) throw new Error("auth.set boom")
            if (opts?.returnSetError) return { error: new Error("auth.set returned error") }
            return { data: true }
          },
        },
      },
    } as any,
    setCalls,
  }
}

function makeServer(handler: (request: Request, url: URL) => Response | Promise<Response>) {
  return Bun.serve({
    port: 0,
    fetch: (request) => handler(request, new URL(request.url)),
  })
}

function serverOptions(server: ReturnType<typeof Bun.serve>) {
  return {
    authorizeUrl: new URL("/oauth2/authorize", server.url).toString(),
    tokenUrl: new URL("/oauth2/token", server.url).toString(),
    deviceAuthorizationUrl: new URL("/oauth2/device/code", server.url).toString(),
  }
}

describe("plugin.xai", () => {
  describe("accessTokenIsExpiring", () => {
    test("returns true for an already-expired JWT", () => {
      expect(accessTokenIsExpiring(makeJwt({ exp: Math.floor(Date.now() / 1000) - 60 }), 0)).toBe(true)
    })

    test("returns false for a fresh JWT outside the skew window", () => {
      expect(accessTokenIsExpiring(makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600 }), 0)).toBe(false)
    })

    test("honors the skew window", () => {
      const nearExpiry = makeJwt({ exp: Math.floor(Date.now() / 1000) + 30 })
      expect(accessTokenIsExpiring(nearExpiry, 60_000)).toBe(true)
      expect(accessTokenIsExpiring(nearExpiry, 0)).toBe(false)
    })

    test("clamps negative skew to zero rather than refusing to refresh", () => {
      expect(accessTokenIsExpiring(makeJwt({ exp: Math.floor(Date.now() / 1000) - 1 }), -60_000)).toBe(true)
    })

    test("returns false for opaque and malformed tokens", () => {
      expect(accessTokenIsExpiring("opaque-token-no-dots", 0)).toBe(false)
      expect(accessTokenIsExpiring("", 0)).toBe(false)
      expect(accessTokenIsExpiring(undefined, 0)).toBe(false)
      expect(accessTokenIsExpiring(makeJwt({ sub: "user-1" }), 0)).toBe(false)
      expect(accessTokenIsExpiring(makeJwt({ exp: "1234" }), 0)).toBe(false)
      expect(accessTokenIsExpiring("header.!!!not-valid-base64-or-json!!!.sig", 0)).toBe(false)
    })
  })

  describe("loader", () => {
    test("returns no options unless stored auth is OAuth and exposes methods in order", async () => {
      const hooks = await XaiAuthPlugin({} as any)
      expect(await hooks.auth!.loader!(async () => ({ type: "api", key: "sk-test" }), {} as any)).toEqual({})
      expect(
        await hooks.auth!.loader!(async () => ({ type: "wellknown", key: "k", token: "t" }) as any, {} as any),
      ).toEqual({})
      expect(hooks.auth!.methods.map((m) => [m.type, m.label])).toEqual([
        ["oauth", "SuperGrok Subscription"],
        ["api", "Manually enter API Key"],
      ])
    })

    test("replaces the dummy bearer, sets User-Agent, and preserves caller headers", async () => {
      const { input, setCalls } = makeInput()
      const captured: Headers[] = []
      using server = makeServer((request) => {
        captured.push(request.headers)
        return new Response("{}", { status: 200 })
      })
      const hooks = await XaiAuthPlugin(input)
      const opts = await hooks.auth!.loader!(
        async () => ({ type: "oauth", access: "live-token", refresh: "rt", expires: Date.now() + 3600_000 }),
        {} as any,
      )
      expect(opts.apiKey).toBe(OAUTH_DUMMY_KEY)
      expect(opts.baseURL).toBeUndefined()

      await opts.fetch!(new URL("/chat/completions", server.url), {
        headers: { Authorization: `Bearer ${OAUTH_DUMMY_KEY}`, "x-keep": "yes" },
      })

      expect(captured[0].get("authorization")).toBe("Bearer live-token")
      expect(captured[0].get("x-keep")).toBe("yes")
      expect(captured[0].get("user-agent")).toMatch(/^opencode\//)
    })

    test("routes first-party OAuth completions through the official proxy contract without changing the body", async () => {
      const { input } = makeInput()
      const body = JSON.stringify({
        model: "grok-3-mini",
        messages: [
          { role: "system", content: "OPERATOR_SYSTEM_BODY_MUST_REMAIN_UNCHANGED_2A70" },
          { role: "user", content: "hello" },
        ],
      })
      const captured: Array<{ url: string; headers: Headers; body: string; method: string }> = []
      using server = makeServer(async (request) => {
        captured.push({
          url: request.url,
          headers: new Headers(request.headers),
          body: await request.text(),
          method: request.method,
        })
        return Response.json({ ok: true })
      })
      const opts = await (
        await XaiAuthPlugin(input, { oauthApiBase: server.url.toString() })
      ).auth!.loader!(
        async () => ({ type: "oauth", access: "oauth-token", refresh: "rt", expires: Date.now() + 3600_000 }),
        {} as any,
      )

      await opts.fetch!("https://api.x.ai/v1/chat/completions?trace=keep", {
        method: "POST",
        headers: { "content-type": "application/json", "x-caller": "preserved" },
        body,
      })
      await opts.fetch!(
        new Request("https://api.x.ai/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json", "x-request-input": "preserved" },
          body,
        }),
      )

      expect(captured[0].url).toBe(new URL("/v1/chat/completions?trace=keep", server.url).toString())
      expect(captured[0].method).toBe("POST")
      expect(captured[0].headers.get("authorization")).toBe("Bearer oauth-token")
      expect(captured[0].headers.get("x-xai-token-auth")).toBe("xai-grok-cli")
      expect(captured[0].headers.get("x-grok-model-override")).toBe("grok-3-mini")
      expect(captured[0].headers.get("x-grok-client-version")).toBe("1.0.45")
      expect(captured[0].headers.get("x-caller")).toBe("preserved")
      expect(captured[0].body).toBe(body)
      expect(captured[1].url).toBe(new URL("/v1/chat/completions", server.url).toString())
      expect(captured[1].headers.get("x-request-input")).toBe("preserved")
      expect(captured[1].headers.get("x-grok-model-override")).toBe("grok-3-mini")
      expect(captured[1].headers.get("x-grok-client-version")).toBe("1.0.45")
      expect(captured[1].body).toBe(body)
    })

    test("does not rewrite custom gateways or add OAuth proxy headers to them", async () => {
      const { input } = makeInput()
      let captured: { url: string; headers: Headers } | undefined
      using server = makeServer((request) => {
        captured = { url: request.url, headers: new Headers(request.headers) }
        return new Response("{}", { status: 200 })
      })
      const opts = await (
        await XaiAuthPlugin(input)
      ).auth!.loader!(
        async () => ({ type: "oauth", access: "oauth-token", refresh: "rt", expires: Date.now() + 3600_000 }),
        {} as any,
      )

      await opts.fetch!(new URL("/custom/chat", server.url), { headers: { "x-caller": "preserved" } })

      expect(captured?.url).toBe(new URL("/custom/chat", server.url).toString())
      expect(captured?.headers.get("x-xai-token-auth")).toBeNull()
      expect(captured?.headers.get("x-grok-model-override")).toBeNull()
      expect(captured?.headers.get("x-grok-client-version")).toBeNull()
      expect(captured?.headers.get("x-caller")).toBe("preserved")
    })

    test("leaves API-key mode on the configured SDK route without Grok OAuth proxy headers", async () => {
      let captured: { url: string; headers: Headers } | undefined
      using server = makeServer((request) => {
        captured = { url: request.url, headers: new Headers(request.headers) }
        return Response.json({ error: { message: "fixture response" } }, { status: 400 })
      })
      const hooks = await XaiAuthPlugin({} as any)
      expect(await hooks.auth!.loader!(async () => ({ type: "api", key: "api-token" }), {} as any)).toEqual({})
      const model = createXai({ apiKey: "api-token", baseURL: `${server.url}/v1` }).responses("grok-build")

      await expect(
        model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }),
      ).rejects.toThrow()

      expect(captured?.url).toBe(new URL("/v1/responses", server.url).toString())
      expect(captured?.headers.get("authorization")).toBe("Bearer api-token")
      expect(captured?.headers.get("x-xai-token-auth")).toBeNull()
      expect(captured?.headers.get("x-grok-model-override")).toBeNull()
      expect(captured?.headers.get("x-grok-client-version")).toBeNull()
    })

    test("routes the real xAI Responses SDK model to the OAuth proxy endpoint", async () => {
      const { input } = makeInput()
      let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined
      using server = makeServer(async (request) => {
        captured = {
          url: request.url,
          headers: new Headers(request.headers),
          body: (await request.json()) as Record<string, unknown>,
        }
        return Response.json({ error: { message: "fixture response" } }, { status: 400 })
      })
      const options = await (
        await XaiAuthPlugin(input, { oauthApiBase: server.url.toString() })
      ).auth!.loader!(
        async () => ({ type: "oauth", access: "oauth-token", refresh: "rt", expires: Date.now() + 3600_000 }),
        {} as any,
      )
      const model = createXai({ apiKey: OAUTH_DUMMY_KEY, fetch: options.fetch as any }).responses("grok-build")

      await expect(
        model.doGenerate({ prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }),
      ).rejects.toThrow()

      expect(captured?.url).toBe(new URL("/v1/responses", server.url).toString())
      expect(captured?.headers.get("authorization")).toBe("Bearer oauth-token")
      expect(captured?.headers.get("x-xai-token-auth")).toBe("xai-grok-cli")
      expect(captured?.headers.get("x-grok-model-override")).toBe("grok-build")
      expect(captured?.headers.get("x-grok-client-version")).toBe("1.0.45")
      expect(captured?.body.model).toBe("grok-build")
      expect(captured?.body.input).toBeDefined()
    })

    test("does not mutate caller headers and supports HeadersInit shapes", async () => {
      const { input } = makeInput()
      const captured: Headers[] = []
      using server = makeServer((request) => {
        captured.push(request.headers)
        return new Response("{}", { status: 200 })
      })
      const opts = await (
        await XaiAuthPlugin(input)
      ).auth!.loader!(
        async () => ({ type: "oauth", access: "tok", refresh: "rt", expires: Date.now() + 3600_000 }),
        {} as any,
      )

      const objHeaders: Record<string, string> = {
        Authorization: `Bearer ${OAUTH_DUMMY_KEY}`,
        "x-trace": "plain-object",
      }
      await opts.fetch!(new URL("/chat/completions", server.url), { headers: objHeaders })
      expect(objHeaders).toEqual({ Authorization: `Bearer ${OAUTH_DUMMY_KEY}`, "x-trace": "plain-object" })

      const arrayHeaders: [string, string][] = [["x-trace", "tuple-array"]]
      const arrayCopy = arrayHeaders.map(([key, value]) => [key, value] as [string, string])
      await opts.fetch!(new URL("/chat/completions", server.url), { headers: arrayHeaders })
      expect(arrayHeaders).toEqual(arrayCopy)

      const headersInstance = new Headers({ "x-trace": "headers-instance" })
      await opts.fetch!(new URL("/chat/completions", server.url), { headers: headersInstance })
      expect(headersInstance.get("x-trace")).toBe("headers-instance")

      expect(captured.map((headers) => headers.get("x-trace"))).toEqual([
        "plain-object",
        "tuple-array",
        "headers-instance",
      ])
      for (const headers of captured) {
        expect(headers.get("authorization")).toBe("Bearer tok")
        expect(headers.get("user-agent")).toMatch(/^opencode\//)
      }
    })

    test("preserves headers from Request input and lets init headers override them", async () => {
      const { input } = makeInput()
      const captured: Headers[] = []
      using server = makeServer((request) => {
        captured.push(request.headers)
        return new Response("{}", { status: 200 })
      })
      const opts = await (
        await XaiAuthPlugin(input)
      ).auth!.loader!(
        async () => ({ type: "oauth", access: "tok", refresh: "rt", expires: Date.now() + 3600_000 }),
        {} as any,
      )

      await opts.fetch!(
        new Request(new URL("/chat/completions", server.url), {
          headers: {
            Authorization: `Bearer ${OAUTH_DUMMY_KEY}`,
            "content-type": "application/json",
            "x-trace": "request",
          },
        }),
        { headers: { "x-trace": "init", "x-extra": "yes" } },
      )

      expect(captured[0].get("authorization")).toBe("Bearer tok")
      expect(captured[0].get("content-type")).toBe("application/json")
      expect(captured[0].get("x-trace")).toBe("init")
      expect(captured[0].get("x-extra")).toBe("yes")
    })

    test("falls through to plain fetch when stored auth flips from oauth to api", async () => {
      const { input } = makeInput()
      const captured: Headers[] = []
      using server = makeServer((request) => {
        captured.push(request.headers)
        return new Response("{}", { status: 200 })
      })
      let firstCall = true
      const opts = await (
        await XaiAuthPlugin(input)
      ).auth!.loader!(async () => {
        if (firstCall) {
          firstCall = false
          return { type: "oauth", access: "tok", refresh: "rt", expires: Date.now() + 3600_000 }
        }
        return { type: "api", key: "sk-new" }
      }, {} as any)

      await opts.fetch!(new URL("/chat/completions", server.url), {
        headers: { Authorization: "Bearer sk-from-aisdk", "x-keep": "v" },
      })
      expect(captured[0].get("authorization")).toBe("Bearer sk-from-aisdk")
      expect(captured[0].get("x-keep")).toBe("v")
    })

    test("deduplicates concurrent refreshes within a loader instance", async () => {
      const { input, setCalls } = makeInput()
      let tokenRequests = 0
      const apiRequests: Headers[] = []
      using server = makeServer(async (request, url) => {
        if (url.pathname === "/oauth2/token") {
          tokenRequests++
          expect(await request.text()).toContain("refresh_token=rt-old")
          await new Promise((resolve) => setTimeout(resolve, 30))
          return Response.json({ access_token: "new-access", refresh_token: "rt-new", expires_in: 3600 })
        }
        apiRequests.push(request.headers)
        return new Response("{}", { status: 200 })
      })
      const opts = await (
        await XaiAuthPlugin(input, serverOptions(server))
      ).auth!.loader!(async () => ({ type: "oauth" as const, access: "old", refresh: "rt-old", expires: 0 }), {} as any)

      await Promise.all([
        opts.fetch!(new URL("/chat/completions", server.url), { headers: {} }),
        opts.fetch!(new URL("/chat/completions", server.url), { headers: {} }),
      ])

      expect(tokenRequests).toBe(1)
      expect(apiRequests.map((headers) => headers.get("authorization"))).toEqual([
        "Bearer new-access",
        "Bearer new-access",
      ])
      expect(setCalls).toHaveLength(1)
      expect((setCalls[0].body as any).refresh).toBe("rt-new")
    })

    test("deduplicates concurrent refreshes across loader instances in this process", async () => {
      const { input, setCalls } = makeInput()
      const tokenRequests: string[] = []
      const apiRequests: string[] = []
      let resolveRefreshStarted: (() => void) | undefined
      let resolveRefresh: (() => void) | undefined
      let resolveBothFetchesReadAuth: (() => void) | undefined
      const refreshStarted = new Promise<void>((resolve) => {
        resolveRefreshStarted = resolve
      })
      const refreshGate = new Promise<void>((resolve) => {
        resolveRefresh = resolve
      })
      const bothFetchesReadAuth = new Promise<void>((resolve) => {
        resolveBothFetchesReadAuth = resolve
      })
      let authReads = 0
      using server = makeServer(async (request, url) => {
        if (url.pathname === "/oauth2/token") {
          const refreshToken = new URLSearchParams(await request.text()).get("refresh_token")!
          tokenRequests.push(refreshToken)
          resolveRefreshStarted?.()
          await refreshGate
          return Response.json({
            access_token: "shared-access",
            refresh_token: "shared-next",
            expires_in: 3600,
          })
        }
        apiRequests.push(request.headers.get("authorization")!)
        return new Response("{}", { status: 200 })
      })
      const hooks = await XaiAuthPlugin(input, serverOptions(server))
      const first = await hooks.auth!.loader!(async () => {
        authReads++
        if (authReads === 4) resolveBothFetchesReadAuth?.()
        return { type: "oauth", access: "old-a", refresh: "rt-shared", expires: 0 }
      }, {} as any)
      const second = await hooks.auth!.loader!(async () => {
        authReads++
        if (authReads === 4) resolveBothFetchesReadAuth?.()
        return { type: "oauth", access: "old-b", refresh: "rt-shared", expires: 0 }
      }, {} as any)

      const requests = Promise.all([
        first.fetch!(new URL("/chat/completions", server.url), { headers: {} }),
        second.fetch!(new URL("/chat/completions", server.url), { headers: {} }),
      ])
      await Promise.all([refreshStarted, bothFetchesReadAuth])
      expect(authReads).toBe(4)
      resolveRefresh?.()
      await requests

      expect(tokenRequests).toEqual(["rt-shared"])
      expect(apiRequests.sort()).toEqual(["Bearer shared-access", "Bearer shared-access"])
      expect(setCalls).toHaveLength(1)
    })

    test("starts a new refresh after success and clears the refresh promise after failure", async () => {
      const { input } = makeInput()
      let tokenRequests = 0
      using server = makeServer((_, url) => {
        if (url.pathname === "/oauth2/token") {
          tokenRequests++
          if (tokenRequests === 2) return new Response("temporarily unavailable", { status: 503 })
          return Response.json({
            access_token: `new-${tokenRequests}`,
            refresh_token: `rt-${tokenRequests}`,
            expires_in: 3600,
          })
        }
        return new Response("{}", { status: 200 })
      })
      const opts = await (
        await XaiAuthPlugin(input, serverOptions(server))
      ).auth!.loader!(async () => ({ type: "oauth", access: "old", refresh: "rt-old", expires: 0 }), {} as any)

      await opts.fetch!(new URL("/chat/completions", server.url), { headers: {} })
      await expect(opts.fetch!(new URL("/chat/completions", server.url), { headers: {} })).rejects.toThrow(
        /xAI token refresh failed \(503\)/,
      )
      await opts.fetch!(new URL("/chat/completions", server.url), { headers: {} })
      expect(tokenRequests).toBe(3)
    })

    test("keeps the old refresh token when omitted and reports persistence failure", async () => {
      const { input, setCalls } = makeInput({ failSet: true })
      const captured: Headers[] = []
      using server = makeServer((request, url) => {
        if (url.pathname === "/oauth2/token") return Response.json({ access_token: "new-access", expires_in: 3600 })
        captured.push(request.headers)
        return new Response("{}", { status: 200 })
      })
      const opts = await (
        await XaiAuthPlugin(input, serverOptions(server))
      ).auth!.loader!(async () => ({ type: "oauth", access: "old", refresh: "rt-old", expires: 0 }), {} as any)

      await expect(opts.fetch!(new URL("/chat/completions", server.url), { headers: {} })).rejects.toThrow(
        "auth.set boom",
      )
      expect(captured).toHaveLength(0)
      expect((setCalls[0].body as any).refresh).toBe("rt-old")
      expect(setCalls[0].throwOnError).toBe(true)
    })

    test("treats a returned SDK persistence error as a failed refresh", async () => {
      const { input, setCalls } = makeInput({ returnSetError: true })
      let apiRequests = 0
      using server = makeServer((_, url) => {
        if (url.pathname === "/oauth2/token")
          return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
        apiRequests++
        return new Response("{}", { status: 200 })
      })
      const opts = await (
        await XaiAuthPlugin(input, serverOptions(server))
      ).auth!.loader!(async () => ({ type: "oauth", access: "old", refresh: "rt", expires: 0 }), {} as any)

      await expect(opts.fetch!(new URL("/chat/completions", server.url), { headers: {} })).rejects.toThrow(
        "xAI refreshed credentials could not be saved",
      )
      expect(setCalls[0].throwOnError).toBe(true)
      expect(apiRequests).toBe(0)
    })

    test("refreshes based on stored expiry or JWT expiry and skips refresh when both are fresh", async () => {
      const { input, setCalls } = makeInput()
      let tokenRequests = 0
      using server = makeServer((_, url) => {
        if (url.pathname === "/oauth2/token") {
          tokenRequests++
          return Response.json({ access_token: "new-access", refresh_token: "rt-new", expires_in: 3600 })
        }
        return new Response("{}", { status: 200 })
      })
      const fresh = await (
        await XaiAuthPlugin(input, serverOptions(server))
      ).auth!.loader!(
        async () => ({
          type: "oauth",
          access: makeJwt({ exp: Math.floor(Date.now() / 1000) + 24 * 3600 }),
          refresh: "rt",
          expires: Date.now() + 24 * 3600 * 1000,
        }),
        {} as any,
      )
      await fresh.fetch!(new URL("/chat/completions", server.url), { headers: {} })
      expect(tokenRequests).toBe(0)

      const jwtExpiring = await (
        await XaiAuthPlugin(input, serverOptions(server))
      ).auth!.loader!(
        async () => ({
          type: "oauth",
          access: makeJwt({ exp: Math.floor((Date.now() + 30_000) / 1000) }),
          refresh: "rt-old",
          expires: Date.now() + 24 * 3600 * 1000,
        }),
        {} as any,
      )
      const missingExpires = await (
        await XaiAuthPlugin(input, serverOptions(server))
      ).auth!.loader!(async () => ({ type: "oauth", access: "opaque-token", refresh: "rt", expires: 0 }), {} as any)
      await jwtExpiring.fetch!(new URL("/chat/completions", server.url), { headers: {} })
      await missingExpires.fetch!(new URL("/chat/completions", server.url), { headers: {} })
      expect(tokenRequests).toBe(2)
      expect(setCalls).toHaveLength(2)
    })

    test("network failure during refresh surfaces the underlying fetch error", async () => {
      const { input } = makeInput()
      const opts = await (
        await XaiAuthPlugin(input, { tokenUrl: "http://127.0.0.1:9/oauth2/token" })
      ).auth!.loader!(async () => ({ type: "oauth", access: "old", refresh: "rt", expires: 0 }), {} as any)

      await expect(opts.fetch!("https://api.x.ai/v1/chat/completions", { headers: {} })).rejects.toThrow()
    })

    test("validates refresh token responses before persistence or API dispatch", async () => {
      const { input, setCalls } = makeInput()
      let apiRequests = 0
      using server = makeServer((_, url) => {
        if (url.pathname === "/oauth2/token") return Response.json({ refresh_token: "rotated", expires_in: 3600 })
        apiRequests++
        return new Response("should not be called")
      })
      const opts = await (
        await XaiAuthPlugin(input, serverOptions(server))
      ).auth!.loader!(async () => ({ type: "oauth", access: "expired", refresh: "rt", expires: 0 }), {} as any)

      await expect(opts.fetch!(new URL("/chat/completions", server.url), { headers: {} })).rejects.toThrow(
        "missing access_token",
      )
      expect(setCalls).toHaveLength(0)
      expect(apiRequests).toBe(0)
    })

    test("times out a stalled refresh response body and honors an already-aborted request", async () => {
      const { input } = makeInput()
      let apiRequests = 0
      using server = makeServer((_, url) => {
        if (url.pathname === "/oauth2/token") {
          return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            headers: { "content-type": "application/json" },
          })
        }
        apiRequests++
        return new Response("api")
      })
      const opts = await (
        await XaiAuthPlugin(input, { ...serverOptions(server), requestTimeoutMs: 20 })
      ).auth!.loader!(async () => ({ type: "oauth", access: "expired", refresh: "rt-timeout", expires: 0 }), {} as any)

      await expect(opts.fetch!(new URL("/chat/completions", server.url), { headers: {} })).rejects.toMatchObject({
        name: "TimeoutError",
      })
      const controller = new AbortController()
      controller.abort()
      await expect(
        opts.fetch!(new URL("/chat/completions", server.url), { headers: {}, signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" })
      expect(apiRequests).toBe(0)
    })

    test("an aborted caller does not replay after a shared refresh finishes", async () => {
      let resolvePersisted: (() => void) | undefined
      const persisted = new Promise<void>((resolve) => {
        resolvePersisted = resolve
      })
      const { input, setCalls } = makeInput({ onSet: () => resolvePersisted?.() })
      let resolveRefreshStarted: (() => void) | undefined
      let resolveRefresh: (() => void) | undefined
      const refreshStarted = new Promise<void>((resolve) => {
        resolveRefreshStarted = resolve
      })
      const refreshGate = new Promise<void>((resolve) => {
        resolveRefresh = resolve
      })
      let apiRequests = 0
      using server = makeServer(async (_, url) => {
        if (url.pathname === "/oauth2/token") {
          resolveRefreshStarted?.()
          await refreshGate
          return Response.json({ access_token: "fresh", refresh_token: "fresh-refresh", expires_in: 3600 })
        }
        apiRequests++
        return new Response("api")
      })
      const opts = await (
        await XaiAuthPlugin(input, { ...serverOptions(server), requestTimeoutMs: 1000 })
      ).auth!.loader!(async () => ({ type: "oauth", access: "expired", refresh: "rt-abort", expires: 0 }), {} as any)
      const controller = new AbortController()
      const request = opts.fetch!(new URL("/chat/completions", server.url), {
        headers: {},
        signal: controller.signal,
      })
      await refreshStarted
      controller.abort(new DOMException("cancelled", "AbortError"))
      await expect(request).rejects.toMatchObject({ name: "AbortError" })
      resolveRefresh?.()
      await persisted
      expect(apiRequests).toBe(0)
      // The shared refresh can finish and persist for other callers after this caller leaves.
      expect(setCalls).toHaveLength(1)
    })

    test("refreshes and replays a replayable request body at most once after 401", async () => {
      const { input, setCalls } = makeInput()
      const bodies: string[] = []
      const authHeaders: Array<string | null> = []
      const clientVersions: Array<string | null> = []
      let tokenRequests = 0
      using server = makeServer(async (request, url) => {
        if (url.pathname === "/oauth2/token") {
          tokenRequests++
          return Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 })
        }
        bodies.push(await request.text())
        authHeaders.push(request.headers.get("authorization"))
        clientVersions.push(request.headers.get("x-grok-client-version"))
        return new Response("unauthorized", { status: 401 })
      })
      const opts = await (
        await XaiAuthPlugin(input, { ...serverOptions(server), oauthApiBase: server.url.toString() })
      ).auth!.loader!(
        async () => ({ type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() + 3600_000 }),
        {} as any,
      )
      const requestBody = JSON.stringify({ model: "grok-build", input: "hello" })
      const response = await opts.fetch!("https://api.x.ai/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: requestBody,
      })

      expect(response.status).toBe(401)
      expect(tokenRequests).toBe(1)
      expect(bodies).toEqual([requestBody, requestBody])
      expect(authHeaders).toEqual(["Bearer old-access", "Bearer fresh-access"])
      expect(clientVersions).toEqual(["1.0.45", "1.0.45"])
      expect(setCalls).toHaveLength(1)
    })

    test("does not retry a 401 for a ReadableStream request body", async () => {
      const { input } = makeInput()
      let apiRequests = 0
      let tokenRequests = 0
      using server = makeServer(async (request, url) => {
        if (url.pathname === "/oauth2/token") {
          tokenRequests++
          return Response.json({ access_token: "fresh", refresh_token: "fresh-refresh", expires_in: 3600 })
        }
        await request.arrayBuffer()
        apiRequests++
        return new Response("unauthorized", { status: 401 })
      })
      const opts = await (
        await XaiAuthPlugin(input, { ...serverOptions(server), oauthApiBase: server.url.toString() })
      ).auth!.loader!(
        async () => ({ type: "oauth", access: "old", refresh: "stream-refresh", expires: Date.now() + 3600_000 }),
        {} as any,
      )
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]))
          controller.close()
        },
      })
      const response = await opts.fetch!(new URL("/chat/completions", server.url), {
        method: "POST",
        body: stream,
        duplex: "half",
      } as RequestInit & { duplex: "half" })

      expect(response.status).toBe(401)
      expect(apiRequests).toBe(1)
      expect(tokenRequests).toBe(0)
    })

    test("retries a replayable JSON streaming request once after 401", async () => {
      const { input, setCalls } = makeInput()
      const bodies: string[] = []
      const authHeaders: Array<string | null> = []
      const clientVersions: Array<string | null> = []
      let apiRequests = 0
      let tokenRequests = 0
      using server = makeServer(async (request, url) => {
        if (url.pathname === "/oauth2/token") {
          tokenRequests++
          return Response.json({ access_token: "fresh", refresh_token: "fresh-refresh", expires_in: 3600 })
        }
        apiRequests++
        bodies.push(await request.text())
        authHeaders.push(request.headers.get("authorization"))
        clientVersions.push(request.headers.get("x-grok-client-version"))
        return new Response("unauthorized", { status: 401 })
      })
      const opts = await (
        await XaiAuthPlugin(input, { ...serverOptions(server), oauthApiBase: server.url.toString() })
      ).auth!.loader!(
        async () => ({ type: "oauth", access: "old", refresh: "stream-refresh", expires: Date.now() + 3600_000 }),
        {} as any,
      )
      const requestBody = JSON.stringify({ model: "grok-build", stream: true, input: "hello" })

      const response = await opts.fetch!("https://api.x.ai/v1/responses", {
        method: "POST",
        headers: { accept: "text/event-stream", "content-type": "application/json" },
        body: requestBody,
      })

      expect(response.status).toBe(401)
      expect(apiRequests).toBe(2)
      expect(tokenRequests).toBe(1)
      expect(setCalls).toHaveLength(1)
      expect(bodies).toEqual([requestBody, requestBody])
      expect(authHeaders).toEqual(["Bearer old", "Bearer fresh"])
      expect(clientVersions).toEqual(["1.0.45", "1.0.45"])
    })

    test("does not refresh after auth is removed while a request is in flight", async () => {
      const { input } = makeInput()
      let authReads = 0
      let tokenRequests = 0
      using server = makeServer((_, url) => {
        if (url.pathname === "/oauth2/token") {
          tokenRequests++
          return Response.json({ access_token: "fresh", refresh_token: "fresh-refresh", expires_in: 3600 })
        }
        return new Response("unauthorized", { status: 401 })
      })
      const opts = await (
        await XaiAuthPlugin(input, serverOptions(server))
      ).auth!.loader!(async () => {
        authReads++
        if (authReads === 3) return undefined as any
        return { type: "oauth", access: "old", refresh: "removed-refresh", expires: Date.now() + 3600_000 }
      }, {} as any)

      const response = await opts.fetch!(new URL("/chat/completions", server.url), {
        method: "POST",
        body: JSON.stringify({ prompt: "x" }),
      })
      expect(response.status).toBe(401)
      expect(await response.text()).toBe("unauthorized")
      expect(tokenRequests).toBe(0)
    })
  })

  describe("device code flow", () => {
    test("authorize advertises verification URL + user code and returns success on callback", async () => {
      using server = makeServer((_, url) => {
        if (url.pathname === "/oauth2/device/code") {
          return Response.json({
            device_code: "DEVICE-1",
            user_code: "ABCD-1234",
            verification_uri: "https://x.ai/device",
            verification_uri_complete: "https://x.ai/device?user_code=ABCD-1234",
            expires_in: 600,
            interval: 5,
          })
        }
        if (url.pathname === "/oauth2/token") {
          return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })
        }
        return new Response("unexpected request", { status: 500 })
      })
      const hooks = await XaiAuthPlugin({} as any, serverOptions(server))
      const headless = hooks.auth!.methods.find(
        (m): m is Extract<typeof m, { type: "oauth" }> => m.type === "oauth" && m.label === "SuperGrok Subscription",
      )!
      const result = await headless.authorize!()

      expect(result.method).toBe("auto")
      expect(result.url).toBe("https://x.ai/device?user_code=ABCD-1234")
      expect(result.instructions).toContain("https://x.ai/device")
      expect(result.instructions).toContain("ABCD-1234")
      expect(await (result as any).callback()).toMatchObject({ type: "success", refresh: "RT", access: "AT" })
    })

    test("authorize falls back to verification_uri when verification_uri_complete is absent", async () => {
      using server = makeServer((_, url) => {
        if (url.pathname === "/oauth2/device/code") {
          return Response.json({
            device_code: "DEVICE-2",
            user_code: "WXYZ-9876",
            verification_uri: "https://x.ai/device",
          })
        }
        return new Response("unexpected request", { status: 500 })
      })
      const headless = (await XaiAuthPlugin({} as any, serverOptions(server))).auth!.methods.find(
        (m): m is Extract<typeof m, { type: "oauth" }> => m.type === "oauth" && m.label === "SuperGrok Subscription",
      )!
      expect((await headless.authorize!()).url).toBe("https://x.ai/device")
    })

    test("requestDeviceCode posts form body, validates fields, and surfaces endpoint errors", async () => {
      let capturedBody = ""
      using server = makeServer(async (request, url) => {
        if (url.pathname === "/missing") return Response.json({ device_code: "x" })
        if (url.pathname === "/error") return new Response("rate limited", { status: 429 })
        expect(request.method).toBe("POST")
        expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
        expect(request.headers.get("accept")).toBe("application/json")
        expect(request.headers.get("user-agent")).toMatch(/^opencode\//)
        capturedBody = await request.text()
        return Response.json({ device_code: "DC", user_code: "UC", verification_uri: "https://x.ai/device" })
      })

      await requestDeviceCode({ deviceAuthorizationUrl: new URL("/oauth2/device/code", server.url).toString() })
      const parsed = new URLSearchParams(capturedBody)
      expect(parsed.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828")
      expect(parsed.get("scope")).toContain("offline_access")
      expect(parsed.get("scope")).toContain("grok-cli:access")
      expect(parsed.get("scope")).toContain("api:access")
      expect(parsed.get("referrer")).toBe("opencode")
      let errorMessage = ""
      try {
        await requestDeviceCode({ deviceAuthorizationUrl: new URL("/error", server.url).toString() })
      } catch (error) {
        errorMessage = String(error)
      }
      expect(errorMessage).toContain("429")
      expect(errorMessage).not.toContain("rate limited")
      await expect(
        requestDeviceCode({ deviceAuthorizationUrl: new URL("/missing", server.url).toString() }),
      ).rejects.toThrow(/missing device_code/)
    })

    test("pollDeviceCodeToken resolves on success and posts the device-code grant", async () => {
      let tokenCalls = 0
      using server = makeServer(async (request) => {
        tokenCalls++
        expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded")
        const body = new URLSearchParams(await request.text())
        expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code")
        expect(body.get("device_code")).toBe("DC-1")
        return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })
      })

      const tokens = await pollDeviceCodeToken(
        { device_code: "DC-1", user_code: "UC", verification_uri: "https://x.ai/device", interval: 1, expires_in: 600 },
        { sleep: async () => {}, tokenUrl: new URL("/oauth2/token", server.url).toString() },
      )
      expect(tokens.access_token).toBe("AT")
      expect(tokens.refresh_token).toBe("RT")
      expect(tokenCalls).toBe(1)
    })

    test("pollDeviceCodeToken honors authorization_pending and slow_down", async () => {
      let n = 0
      using server = makeServer(() => {
        n++
        if (n === 1) return Response.json({ error: "authorization_pending" }, { status: 400 })
        if (n === 2) return Response.json({ error: "slow_down" }, { status: 400 })
        return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })
      })
      const sleeps: number[] = []
      const tokens = await pollDeviceCodeToken(
        { device_code: "DC", user_code: "UC", verification_uri: "https://x.ai/device", interval: 5, expires_in: 600 },
        { sleep: async (ms) => void sleeps.push(ms), tokenUrl: new URL("/oauth2/token", server.url).toString() },
      )
      expect(tokens.access_token).toBe("AT")
      expect(n).toBe(3)
      expect(sleeps).toEqual([8_000, 13_000])
    })

    test("pollDeviceCodeToken handles terminal errors and timeout", async () => {
      for (const [body, error] of [
        [{ error: "access_denied" }, /authorization was denied/],
        [{ error: "expired_token" }, /device code expired/],
        [{ error: "server_error", error_description: "oops" }, /500.*server_error/],
      ] as const) {
        using server = makeServer(() => Response.json(body, { status: 500 }))
        await expect(
          pollDeviceCodeToken(
            {
              device_code: "DC",
              user_code: "UC",
              verification_uri: "https://x.ai/device",
              interval: 1,
              expires_in: 600,
            },
            { sleep: async () => {}, tokenUrl: new URL("/oauth2/token", server.url).toString() },
          ),
        ).rejects.toThrow(error)
      }

      using pending = makeServer(() => Response.json({ error: "authorization_pending" }, { status: 400 }))
      let tick = 0
      await expect(
        pollDeviceCodeToken(
          { device_code: "DC", user_code: "UC", verification_uri: "https://x.ai/device", interval: 1, expires_in: 1 },
          {
            sleep: async () => {},
            now: () => 1_000_000 + tick++ * 600,
            tokenUrl: new URL("/oauth2/token", pending.url).toString(),
          },
        ),
      ).rejects.toThrow(/timed out/)
    })

    test("validates successful token payloads and aborts a pending poll sleep", async () => {
      using invalid = makeServer(() => Response.json({ access_token: "AT", expires_in: 3600 }))
      await expect(
        pollDeviceCodeToken(
          { device_code: "DC", user_code: "UC", verification_uri: "https://x.ai/device", interval: 1, expires_in: 10 },
          { tokenUrl: invalid.url.toString() },
        ),
      ).rejects.toThrow("missing refresh_token")

      let resolveSleep: (() => void) | undefined
      const sleepStarted = new Promise<void>((resolve) => {
        resolveSleep = resolve
      })
      let calls = 0
      using pending = makeServer(() => {
        calls++
        return Response.json({ error: "authorization_pending" }, { status: 400 })
      })
      const controller = new AbortController()
      const polling = pollDeviceCodeToken(
        { device_code: "DC", user_code: "UC", verification_uri: "https://x.ai/device", interval: 1, expires_in: 60 },
        {
          tokenUrl: pending.url.toString(),
          signal: controller.signal,
          sleep: async (_ms, signal) => {
            resolveSleep?.()
            await new Promise<void>((resolve, reject) => {
              if (signal?.aborted) return reject(signal.reason)
              signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
            })
          },
        },
      )
      await sleepStarted
      controller.abort(new DOMException("cancelled", "AbortError"))
      await expect(polling).rejects.toMatchObject({ name: "AbortError" })
      expect(calls).toBe(1)
    })

    test("plugin disposal aborts an active device-code poll", async () => {
      let resolvePollStarted: (() => void) | undefined
      const pollStarted = new Promise<void>((resolve) => {
        resolvePollStarted = resolve
      })
      let pollCalls = 0
      using server = makeServer((_, url) => {
        if (url.pathname === "/oauth2/device/code") {
          return Response.json({
            device_code: "DC",
            user_code: "UC",
            verification_uri: "https://x.ai/device",
            interval: 1,
            expires_in: 60,
          })
        }
        pollCalls++
        resolvePollStarted?.()
        return Response.json({ error: "authorization_pending" }, { status: 400 })
      })
      const hooks = await XaiAuthPlugin({} as any, serverOptions(server))
      const method = hooks.auth!.methods.find(
        (item): item is Extract<typeof item, { type: "oauth" }> => item.type === "oauth",
      )!
      const authorization = await method.authorize!()
      const callback = (authorization as any).callback()
      await pollStarted
      await hooks.dispose?.()

      expect(await callback).toEqual({ type: "failed" })
      expect(pollCalls).toBe(1)
    })

    test("pollDeviceCodeToken normalizes bad interval and expires_in values", async () => {
      const badIntervals: Array<unknown> = [Number.NaN, "NaN", "garbage", -5, null, 0]
      for (const bad of badIntervals) {
        let n = 0
        using server = makeServer(() => {
          n++
          if (n === 1) return Response.json({ error: "authorization_pending" }, { status: 400 })
          return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 })
        })
        const sleeps: number[] = []
        await pollDeviceCodeToken(
          {
            device_code: "DC",
            user_code: "UC",
            verification_uri: "https://x.ai/device",
            interval: bad as number,
            expires_in: 600,
          },
          { sleep: async (ms) => void sleeps.push(ms), tokenUrl: new URL("/oauth2/token", server.url).toString() },
        )
        expect(sleeps[0]).toBe(8_000)
      }

      for (const bad of [Number.NaN, "NaN", "garbage", -5, null, 0]) {
        using server = makeServer(() => Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 3600 }))
        expect(
          (
            await pollDeviceCodeToken(
              {
                device_code: "DC",
                user_code: "UC",
                verification_uri: "https://x.ai/device",
                interval: 1,
                expires_in: bad as number,
              },
              { sleep: async () => {}, tokenUrl: new URL("/oauth2/token", server.url).toString() },
            )
          ).access_token,
        ).toBe("AT")
      }
    })

    test("device-code authorize callback returns failed when polling errors", async () => {
      using server = makeServer((_, url) => {
        if (url.pathname === "/oauth2/device/code") {
          return Response.json({
            device_code: "DC",
            user_code: "UC",
            verification_uri: "https://x.ai/device",
            interval: 0,
            expires_in: 600,
          })
        }
        return Response.json({ error: "access_denied" }, { status: 400 })
      })
      const headless = (await XaiAuthPlugin({} as any, serverOptions(server))).auth!.methods.find(
        (m): m is Extract<typeof m, { type: "oauth" }> => m.type === "oauth" && m.label === "SuperGrok Subscription",
      )!
      expect(await ((await headless.authorize!()) as any).callback()).toEqual({ type: "failed" })
    })
  })
})
