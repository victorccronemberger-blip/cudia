import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import {
  KIMI_API_BASE_URL,
  KIMI_CLIENT_ID,
  KimiAuthPlugin,
  pollDeviceCodeToken,
  readKimiCredentials,
  refreshAccessToken,
  requestDeviceCode,
  writeKimiCredentials,
} from "../../src/plugin/kimi"
import { OAUTH_DUMMY_KEY } from "../../src/auth"

function makeInput(opts?: { failSet?: boolean }) {
  const setCalls: Array<Record<string, unknown>> = []
  return {
    input: {
      client: {
        auth: {
          set: async (req: Record<string, unknown>) => {
            setCalls.push(req)
            if (opts?.failSet) throw new Error("auth.set boom")
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
    oauthHost: server.url.origin,
    apiBaseUrl: new URL("/coding/v1", server.url).toString(),
    credentialsPath: path.join(os.tmpdir(), `kimi-test-creds-${Math.random().toString(36).slice(2)}.json`),
  }
}

function oauthAuth(overrides: Partial<{ access: string; refresh: string; expires: number }> = {}) {
  return {
    type: "oauth" as const,
    access: overrides.access ?? "access-token",
    refresh: overrides.refresh ?? "refresh-token",
    expires: overrides.expires ?? Date.now() + 3600_000,
  }
}

describe("plugin.kimi", () => {
  describe("requestDeviceCode", () => {
    test("sends client_id to the device_authorization endpoint and parses the response", async () => {
      let recordedBody: string | undefined
      using server = makeServer(async (request) => {
        recordedBody = await request.text()
        return Response.json({
          device_code: "devcode123",
          user_code: "WDJB-MJHT",
          verification_uri: new URL("/verify", server.url).toString(),
          verification_uri_complete: new URL("/verify?user_code=WDJB-MJHT", server.url).toString(),
          expires_in: 900,
          interval: 5,
        })
      })
      const result = await requestDeviceCode(serverOptions(server))

      expect(result.device_code).toBe("devcode123")
      expect(result.user_code).toBe("WDJB-MJHT")
      expect(result.verification_uri).toBe(new URL("/verify", server.url).toString())
      expect(result.verification_uri_complete).toBe(new URL("/verify?user_code=WDJB-MJHT", server.url).toString())
      expect(recordedBody).toBe(`client_id=${KIMI_CLIENT_ID}`)
    })

    test("throws when user_code or device_code is missing", async () => {
      using server = makeServer(() =>
        Response.json({ verification_uri: "https://auth.kimi.com/verify" }),
      )
      await expect(requestDeviceCode(serverOptions(server))).rejects.toThrow("missing user_code / device_code")
    })

    test("throws on non-200 with error_description detail", async () => {
      using server = makeServer(() => Response.json({ error_description: "client rejected" }, { status: 400 }))
      await expect(requestDeviceCode(serverOptions(server))).rejects.toThrow("failed (400): client rejected")
    })
  })

  describe("pollDeviceCodeToken", () => {
    test("polls with grant_type=device_code and parses success", async () => {
      const bodies: string[] = []
      using server = makeServer(async (request) => {
        bodies.push(await request.text())
        return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 900, scope: "kimi-code" })
      })
      const device = {
        device_code: "devcode123",
        user_code: "WDJB-MJHT",
        verification_uri: "https://auth.kimi.com/verify",
        expires_in: 900,
      }
      const tokens = await pollDeviceCodeToken(device, {
        ...serverOptions(server),
        sleep: async () => {},
        now: () => 0,
      })

      expect(tokens.access_token).toBe("AT")
      expect(tokens.refresh_token).toBe("RT")
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toBe(
        `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&client_id=${KIMI_CLIENT_ID}&device_code=devcode123`,
      )
    })

    test("keeps polling on authorization_pending and succeeds later", async () => {
      let calls = 0
      const sleeps: number[] = []
      using server = makeServer(() => {
        calls += 1
        if (calls < 3) return Response.json({ error: "authorization_pending" }, { status: 400 })
        return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 900 })
      })
      const device = {
        device_code: "devcode123",
        user_code: "WDJB-MJHT",
        verification_uri: "https://auth.kimi.com/verify",
        expires_in: 900,
        interval: 5,
      }
      const tokens = await pollDeviceCodeToken(device, {
        ...serverOptions(server),
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        now: () => 0,
      })

      expect(tokens.access_token).toBe("AT")
      expect(calls).toBe(3)
      expect(sleeps).toEqual([8_000, 8_000])
    })

    test("bumps the interval on slow_down", async () => {
      let calls = 0
      const sleeps: number[] = []
      using server = makeServer(() => {
        calls += 1
        if (calls < 3) return Response.json({ error: "slow_down" }, { status: 400 })
        return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 900 })
      })
      const device = {
        device_code: "devcode123",
        user_code: "WDJB-MJHT",
        verification_uri: "https://auth.kimi.com/verify",
        expires_in: 900,
        interval: 5,
      }
      const tokens = await pollDeviceCodeToken(device, {
        ...serverOptions(server),
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        now: () => 0,
      })

      expect(tokens.access_token).toBe("AT")
      expect(sleeps).toEqual([13_000, 18_000])
    })

    test("throws on expired_token", async () => {
      using server = makeServer(() => Response.json({ error: "expired_token" }, { status: 400 }))
      const device = {
        device_code: "devcode123",
        user_code: "WDJB-MJHT",
        verification_uri: "https://auth.kimi.com/verify",
        expires_in: 900,
      }
      await expect(
        pollDeviceCodeToken(device, { ...serverOptions(server), sleep: async () => {}, now: () => 0 }),
      ).rejects.toThrow("device code expired")
    })

    test("throws on access_denied", async () => {
      using server = makeServer(() => Response.json({ error: "access_denied" }, { status: 400 }))
      const device = {
        device_code: "devcode123",
        user_code: "WDJB-MJHT",
        verification_uri: "https://auth.kimi.com/verify",
        expires_in: 900,
      }
      await expect(
        pollDeviceCodeToken(device, { ...serverOptions(server), sleep: async () => {}, now: () => 0 }),
      ).rejects.toThrow("authorization was denied")
    })

    test("throws when the deadline passes", async () => {
      using server = makeServer(() => Response.json({ error: "authorization_pending" }, { status: 400 }))
      const device = {
        device_code: "devcode123",
        user_code: "WDJB-MJHT",
        verification_uri: "https://auth.kimi.com/verify",
        expires_in: 5,
      }
      let time = 0
      await expect(
        pollDeviceCodeToken(device, {
          ...serverOptions(server),
          sleep: async (ms) => {
            time += ms
          },
          now: () => time,
        }),
      ).rejects.toThrow("timed out")
    })
  })

  describe("refreshAccessToken", () => {
    test("sends grant_type=refresh_token with client_id and parses rotated tokens", async () => {
      let recordedBody: string | undefined
      using server = makeServer(async (request) => {
        recordedBody = await request.text()
        return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 900 })
      })
      const tokens = await refreshAccessToken("refresh-old", serverOptions(server))

      expect(tokens.access_token).toBe("new-access")
      expect(tokens.refresh_token).toBe("new-refresh")
      expect(recordedBody).toBe(`grant_type=refresh_token&client_id=${KIMI_CLIENT_ID}&refresh_token=refresh-old`)
    })

    test("throws on invalid_grant", async () => {
      using server = makeServer(() => Response.json({ error: "invalid_grant", error_description: "expired" }, { status: 400 }))
      await expect(refreshAccessToken("refresh-old", serverOptions(server))).rejects.toThrow(
        "failed (400): expired",
      )
    })
  })

  describe("credentials file import / sync", () => {
    test("readKimiCredentials parses the kimi-code file format", async () => {
      const opts = { credentialsPath: path.join(os.tmpdir(), `kimi-test-${Math.random()}.json`) }
      await Bun.write(
        opts.credentialsPath,
        JSON.stringify({
          access_token: "file-access",
          refresh_token: "file-refresh",
          expires_at: 1786716867,
          scope: "kimi-code",
          token_type: "Bearer",
          expires_in: 900,
        }),
      )
      expect(await readKimiCredentials(opts)).toEqual({
        access: "file-access",
        refresh: "file-refresh",
        expires: 1786716867000,
      })
    })

    test("readKimiCredentials returns undefined for a missing or malformed file", async () => {
      expect(await readKimiCredentials({ credentialsPath: path.join(os.tmpdir(), "kimi-nope.json") })).toBeUndefined()
      const opts = { credentialsPath: path.join(os.tmpdir(), `kimi-test-${Math.random()}.json`) }
      await Bun.write(opts.credentialsPath, JSON.stringify({ access_token: "no-refresh" }))
      expect(await readKimiCredentials(opts)).toBeUndefined()
    })

    test("writeKimiCredentials rotates the tokens and preserves other fields", async () => {
      const opts = { credentialsPath: path.join(os.tmpdir(), `kimi-test-${Math.random()}.json`) }
      await Bun.write(
        opts.credentialsPath,
        JSON.stringify({ access_token: "old", refresh_token: "old-rt", expires_at: 1, scope: "kimi-code" }),
      )
      await writeKimiCredentials({ access: "new", refresh: "new-rt", expires: 2000000000000 }, opts)
      const next = await Bun.file(opts.credentialsPath).json()
      expect(next).toEqual({
        access_token: "new",
        refresh_token: "new-rt",
        expires_at: 2000000000,
        scope: "kimi-code",
      })
    })
  })

  describe("loader", () => {
    test("returns no options unless stored auth is OAuth and exposes methods in order", async () => {
      const hooks = await KimiAuthPlugin({} as any)
      expect(await hooks.auth!.loader!(async () => ({ type: "api", key: "sk-test" }), {} as any)).toEqual({})
      expect(
        await hooks.auth!.loader!(async () => ({ type: "wellknown", key: "k", token: "t" }) as any, {} as any),
      ).toEqual({})
      expect(hooks.auth!.methods.map((m) => [m.type, m.label])).toEqual([
        ["oauth", "Kimi Code OAuth (Kimi subscription)"],
        ["api", "Manually enter API Key"],
      ])
    })

    test("replaces the dummy bearer, sets User-Agent, and preserves caller headers", async () => {
      const { input } = makeInput()
      const captured: Headers[] = []
      using server = makeServer((request) => {
        captured.push(request.headers)
        return new Response("{}", { status: 200 })
      })
      const hooks = await KimiAuthPlugin(input)
      const opts = await hooks.auth!.loader!(async () => oauthAuth(), {} as any)
      expect(opts.apiKey).toBe(OAUTH_DUMMY_KEY)
      expect(opts.baseURL).toBe(KIMI_API_BASE_URL)

      await opts.fetch!(new URL("/coding/v1/chat/completions", server.url), {
        headers: { Authorization: `Bearer ${OAUTH_DUMMY_KEY}`, "x-keep": "yes" },
      })

      expect(captured[0].get("authorization")).toBe("Bearer access-token")
      expect(captured[0].get("x-keep")).toBe("yes")
      expect(captured[0].get("user-agent")).toMatch(/^opencode\//)
    })

    test("refreshes an expiring token once across concurrent requests and persists the rotated pair", async () => {
      const { input, setCalls } = makeInput()
      let refreshCalls = 0
      using server = makeServer((request, url) => {
        if (url.pathname === "/api/oauth/token") {
          refreshCalls += 1
          return Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 900 })
        }
        return new Response("{}", { status: 200 })
      })
      const hooks = await KimiAuthPlugin(input, serverOptions(server))
      const opts = await hooks.auth!.loader!(async () => oauthAuth({ expires: Date.now() - 1000 }), {} as any)

      const [first, second] = await Promise.all([
        opts.fetch!(new URL("/coding/v1/chat/completions", server.url), { headers: {} }),
        opts.fetch!(new URL("/coding/v1/chat/completions", server.url), { headers: {} }),
      ])
      expect(first.status).toBe(200)
      expect(second.status).toBe(200)
      expect(refreshCalls).toBe(1)

      expect(setCalls).toHaveLength(1)
      expect(setCalls[0].path).toEqual({ id: "moonshotai" })
      expect(setCalls[0].body).toEqual({
        type: "oauth",
        access: "fresh-access",
        refresh: "fresh-refresh",
        expires: expect.any(Number),
      })
    })

    test("still serves the request when persisting the rotated pair fails", async () => {
      const { input } = makeInput({ failSet: true })
      const captured: string[] = []
      using server = makeServer((request, url) => {
        if (url.pathname === "/api/oauth/token") {
          return Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 900 })
        }
        captured.push(request.headers.get("authorization") ?? "")
        return new Response("{}", { status: 200 })
      })
      const hooks = await KimiAuthPlugin(input, serverOptions(server))
      const opts = await hooks.auth!.loader!(async () => oauthAuth({ expires: Date.now() - 1000 }), {} as any)
      const response = await opts.fetch!(new URL("/coding/v1/chat/completions", server.url), { headers: {} })

      expect(response.status).toBe(200)
      expect(captured[0]).toBe("Bearer fresh-access")
    })

    test("adopts a fresher session from the shared credentials file before refreshing", async () => {
      const { input, setCalls } = makeInput()
      const credentialsPath = path.join(os.tmpdir(), `kimi-test-creds-${Math.random()}.json`)
      await Bun.write(
        credentialsPath,
        JSON.stringify({ access_token: "peer-access", refresh_token: "peer-refresh", expires_at: 1 }),
      )
      const refreshBodies: string[] = []
      using server = makeServer(async (request, url) => {
        if (url.pathname === "/api/oauth/token") {
          refreshBodies.push(await request.text())
          return Response.json({ access_token: "adopted-access", refresh_token: "adopted-refresh", expires_in: 900 })
        }
        return new Response("{}", { status: 200 })
      })
      const options = { ...serverOptions(server), credentialsPath }
      const hooks = await KimiAuthPlugin(input, options)
      const opts = await hooks.auth!.loader!(
        async () => oauthAuth({ refresh: "stored-refresh", expires: Date.now() - 1000 }),
        {} as any,
      )
      await opts.fetch!(new URL("/coding/v1/chat/completions", server.url), { headers: {} })

      // The peer's refresh_token was used, not the stale stored one.
      expect(refreshBodies[0]).toContain("refresh_token=peer-refresh")
      expect(setCalls[0].body).toMatchObject({ access: "adopted-access", refresh: "adopted-refresh" })
      // The shared file was rotated back in sync.
      const file = await Bun.file(credentialsPath).json()
      expect(file.refresh_token).toBe("adopted-refresh")
    })

    test("recovers when the peer rotates the refresh_token mid-flight", async () => {
      const { input, setCalls } = makeInput()
      const credentialsPath = path.join(os.tmpdir(), `kimi-test-creds-${Math.random()}.json`)
      await Bun.write(
        credentialsPath,
        JSON.stringify({ access_token: "peer-access", refresh_token: "stored-refresh", expires_at: 1 }),
      )
      const refreshBodies: string[] = []
      using server = makeServer(async (request, url) => {
        if (url.pathname === "/api/oauth/token") {
          refreshBodies.push(await request.text())
          if (refreshBodies.length === 1) {
            // Peer rotates the session while our first refresh attempt fails.
            await Bun.write(
              credentialsPath,
              JSON.stringify({ access_token: "peer-access", refresh_token: "peer-rotated", expires_at: 1 }),
            )
            return Response.json({ error: "invalid_grant" }, { status: 400 })
          }
          return Response.json({ access_token: "recovered-access", refresh_token: "recovered-refresh", expires_in: 900 })
        }
        return new Response("{}", { status: 200 })
      })
      const options = { ...serverOptions(server), credentialsPath }
      const hooks = await KimiAuthPlugin(input, options)
      const opts = await hooks.auth!.loader!(
        async () => oauthAuth({ refresh: "stored-refresh", expires: Date.now() - 1000 }),
        {} as any,
      )
      const response = await opts.fetch!(new URL("/coding/v1/chat/completions", server.url), { headers: {} })

      expect(response.status).toBe(200)
      expect(refreshBodies).toHaveLength(2)
      expect(refreshBodies[1]).toContain("refresh_token=peer-rotated")
      expect(setCalls[0].body).toMatchObject({ access: "recovered-access", refresh: "recovered-refresh" })
    })
  })

  describe("provider.models", () => {
    const provider = { models: { "some-old-model": { id: "x" } } } as any

    test("keeps existing models for api auth", async () => {
      const hooks = await KimiAuthPlugin({} as any)
      const models = await hooks.provider!.models!(provider, { auth: { type: "api", key: "sk" } } as any)
      expect(models).toEqual(provider.models)
    })

    test("swaps in the coding catalog for oauth auth", async () => {
      const hooks = await KimiAuthPlugin({} as any)
      const models = await hooks.provider!.models!(provider, { auth: oauthAuth() } as any)
      expect(Object.keys(models)).toEqual(["kimi-for-coding", "kimi-for-coding-highspeed", "k3", "k3-256k"])

      const k3 = models["k3"]!
      expect(k3.api.npm).toBe("@ai-sdk/openai-compatible")
      expect(k3.api.url).toBe(KIMI_API_BASE_URL)
      expect(k3.limit.context).toBe(1048576)
      expect(k3.capabilities.reasoning).toBe(true)
      expect(k3.capabilities.toolcall).toBe(true)
      expect(k3.capabilities.input.video).toBe(true)
      expect(k3.capabilities.interleaved).toEqual({ field: "reasoning_content" })
      expect(k3.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
      expect(models["k3-256k"]!.capabilities.input.video).toBe(false)
    })
  })
})
