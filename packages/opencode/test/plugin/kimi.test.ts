import { afterAll, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { mkdtemp, readdir, rm, stat } from "node:fs/promises"
import type { Auth, Provider } from "@opencode-ai/sdk/v2"
import type { PluginInput } from "@opencode-ai/plugin"
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

const credentialFiles = new Set<string>()
const emptyProvider = {
  id: "moonshotai",
  name: "Moonshot",
  source: "custom" as const,
  env: [],
  options: {},
  models: {},
}

function temporaryCredentials() {
  const file = path.join(os.tmpdir(), `kimi-test-${crypto.randomUUID()}.json`)
  credentialFiles.add(file)
  return file
}

// These HTTP-only plugin tests do not need the project/bootstrap runtime that
// the shared instance fixture loads.
async function tmpdir() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kimi-test-"))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir())) {
        throw new Error("Unexpected Kimi test directory")
      }
      await rm(directory, { recursive: true, force: true })
    },
  }
}

afterAll(() => Promise.all(Array.from(credentialFiles, (file) => rm(file, { force: true }))))

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
    } as unknown as PluginInput,
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
    credentialsPath: temporaryCredentials(),
    syncCredentials: false,
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
      using server = makeServer(() => Response.json({ verification_uri: "https://auth.kimi.com/verify" }))
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
      using server = makeServer(() =>
        Response.json({ error: "invalid_grant", error_description: "expired" }, { status: 400 }),
      )
      await expect(refreshAccessToken("refresh-old", serverOptions(server))).rejects.toThrow("failed (400): expired")
    })
  })

  describe("credentials file import / sync", () => {
    test("readKimiCredentials parses the kimi-code file format", async () => {
      const opts = { credentialsPath: temporaryCredentials() }
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
      expect(await readKimiCredentials({ credentialsPath: temporaryCredentials() })).toBeUndefined()
      const opts = { credentialsPath: temporaryCredentials() }
      await Bun.write(opts.credentialsPath, JSON.stringify({ access_token: "no-refresh" }))
      expect(await readKimiCredentials(opts)).toBeUndefined()
    })

    test("writeKimiCredentials rotates the tokens and preserves other fields", async () => {
      const opts = { credentialsPath: temporaryCredentials() }
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

    test.skipIf(process.platform === "win32")("creates private credential files", async () => {
      const options = { credentialsPath: temporaryCredentials() }
      await writeKimiCredentials(
        { access: "private-access", refresh: "private-refresh", expires: 2000000000000 },
        options,
      )
      expect((await stat(options.credentialsPath)).mode & 0o777).toBe(0o600)
    })

    test("publishes complete credentials during concurrent writes and removes temporary files", async () => {
      await using tmp = await tmpdir()
      const options = { credentialsPath: path.join(tmp.path, "kimi-code.json") }
      await writeKimiCredentials({ access: "initial", refresh: "initial", expires: 2000000000000 }, options)
      let complete = false
      const writes = Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          writeKimiCredentials(
            { access: `access-${index}`, refresh: `refresh-${index}`, expires: 2000000000000 },
            options,
          ),
        ),
      ).finally(() => {
        complete = true
      })
      while (!complete) {
        const credentials = await Bun.file(options.credentialsPath).json()
        expect(typeof credentials.access_token).toBe("string")
        expect(typeof credentials.refresh_token).toBe("string")
      }
      await writes
      expect(await readdir(tmp.path)).toEqual(["kimi-code.json"])
    })

    test("an opted-in login replaces the old shared session", async () => {
      const credentialsPath = temporaryCredentials()
      await Bun.write(
        credentialsPath,
        JSON.stringify({ access_token: "old-access", refresh_token: "old-refresh", expires_at: 1 }),
      )
      using server = makeServer((_request, url) => {
        if (url.pathname === "/api/oauth/device_authorization") {
          return Response.json({
            device_code: "device",
            user_code: "code",
            verification_uri: new URL("/verify", url).toString(),
          })
        }
        return Response.json({ access_token: "login-access", refresh_token: "login-refresh", expires_in: 900 })
      })
      const hooks = await KimiAuthPlugin(makeInput().input, {
        ...serverOptions(server),
        credentialsPath,
        syncCredentials: true,
      })
      const method = hooks.auth!.methods[0]
      if (method.type !== "oauth") throw new Error("Expected OAuth method")
      const authorization = await method.authorize()
      if (authorization.method !== "auto") throw new Error("Expected automatic callback")
      expect(await authorization.callback()).toMatchObject({
        type: "success",
        access: "login-access",
        refresh: "login-refresh",
      })
      expect(await readKimiCredentials({ credentialsPath })).toMatchObject({
        access: "login-access",
        refresh: "login-refresh",
      })
    })
  })

  describe("loader", () => {
    test("returns no options unless stored auth is OAuth and exposes methods in order", async () => {
      const hooks = await KimiAuthPlugin(makeInput().input)
      expect(await hooks.auth!.loader!(async () => ({ type: "api", key: "sk-test" }), emptyProvider)).toEqual({})
      expect(
        await hooks.auth!.loader!(async () => ({ type: "wellknown", key: "k", token: "t" }), emptyProvider),
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
      const opts = await hooks.auth!.loader!(async () => oauthAuth(), emptyProvider)
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
      const opts = await hooks.auth!.loader!(async () => oauthAuth({ expires: Date.now() - 1000 }), emptyProvider)

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
      const opts = await hooks.auth!.loader!(async () => oauthAuth({ expires: Date.now() - 1000 }), emptyProvider)
      const response = await opts.fetch!(new URL("/coding/v1/chat/completions", server.url), { headers: {} })

      expect(response.status).toBe(200)
      expect(captured[0]).toBe("Bearer fresh-access")
    })

    test("reuses a fresher shared session without rotating it again", async () => {
      const { input, setCalls } = makeInput()
      const credentialsPath = temporaryCredentials()
      await Bun.write(
        credentialsPath,
        JSON.stringify({
          access_token: "peer-access",
          refresh_token: "peer-refresh",
          expires_at: Math.floor(Date.now() / 1000) + 900,
        }),
      )
      const refreshBodies: string[] = []
      using server = makeServer(async (request, url) => {
        if (url.pathname === "/api/oauth/token") {
          refreshBodies.push(await request.text())
          return Response.json({ access_token: "adopted-access", refresh_token: "adopted-refresh", expires_in: 900 })
        }
        return new Response("{}", { status: 200 })
      })
      const options = { ...serverOptions(server), credentialsPath, syncCredentials: true }
      const hooks = await KimiAuthPlugin(input, options)
      const opts = await hooks.auth!.loader!(
        async () => oauthAuth({ refresh: "stored-refresh", expires: Date.now() - 1000 }),
        emptyProvider,
      )
      await opts.fetch!(new URL("/coding/v1/chat/completions", server.url), { headers: {} })

      expect(refreshBodies).toHaveLength(0)
      expect(setCalls[0].body).toMatchObject({ access: "peer-access", refresh: "peer-refresh" })
      const file = await Bun.file(credentialsPath).json()
      expect(file.refresh_token).toBe("peer-refresh")
    })

    test("recovers when the peer rotates the refresh_token mid-flight", async () => {
      const { input, setCalls } = makeInput()
      const credentialsPath = temporaryCredentials()
      const expires = Date.now() - 60_000
      await Bun.write(
        credentialsPath,
        JSON.stringify({
          access_token: "peer-access",
          refresh_token: "stored-refresh",
          expires_at: Math.floor(expires / 1000),
        }),
      )
      const refreshBodies: string[] = []
      using server = makeServer(async (request, url) => {
        if (url.pathname === "/api/oauth/token") {
          refreshBodies.push(await request.text())
          if (refreshBodies.length === 1) {
            // Peer rotates the session while our first refresh attempt fails.
            await Bun.write(
              credentialsPath,
              JSON.stringify({
                access_token: "peer-access",
                refresh_token: "peer-rotated",
                expires_at: Math.floor(expires / 1000) + 30,
              }),
            )
            return Response.json({ error: "invalid_grant" }, { status: 400 })
          }
          return Response.json({
            access_token: "recovered-access",
            refresh_token: "recovered-refresh",
            expires_in: 900,
          })
        }
        return new Response("{}", { status: 200 })
      })
      const options = { ...serverOptions(server), credentialsPath, syncCredentials: true }
      const hooks = await KimiAuthPlugin(input, options)
      const opts = await hooks.auth!.loader!(
        async () => oauthAuth({ refresh: "stored-refresh", expires }),
        emptyProvider,
      )
      const response = await opts.fetch!(new URL("/coding/v1/chat/completions", server.url), { headers: {} })

      expect(response.status).toBe(200)
      expect(refreshBodies).toHaveLength(2)
      expect(refreshBodies[1]).toContain("refresh_token=peer-rotated")
      expect(setCalls[0].body).toMatchObject({ access: "recovered-access", refresh: "recovered-refresh" })
    })

    test("ignores an older shared session even when sharing is enabled", async () => {
      const credentialsPath = temporaryCredentials()
      const expires = Date.now() - 1000
      await Bun.write(
        credentialsPath,
        JSON.stringify({
          access_token: "old-account",
          refresh_token: "old-refresh",
          expires_at: Math.floor(expires / 1000) - 3600,
        }),
      )
      const bodies: string[] = []
      using server = makeServer(async (request, url) => {
        if (url.pathname === "/api/oauth/token") {
          bodies.push(await request.text())
          return Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 900 })
        }
        return Response.json({})
      })
      const hooks = await KimiAuthPlugin(makeInput().input, {
        ...serverOptions(server),
        credentialsPath,
        syncCredentials: true,
      })
      const opts = await hooks.auth!.loader!(
        async () => oauthAuth({ refresh: "current-refresh", expires }),
        emptyProvider,
      )
      await opts.fetch!(new URL("/coding/v1/chat/completions", server.url))
      expect(bodies).toHaveLength(1)
      expect(bodies[0]).toContain("refresh_token=current-refresh")
    })

    test("leaves another client's credentials untouched unless sharing is enabled", async () => {
      const credentialsPath = temporaryCredentials()
      const original = {
        access_token: "other-account",
        refresh_token: "other-refresh",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }
      await Bun.write(credentialsPath, JSON.stringify(original))
      const bodies: string[] = []
      using server = makeServer(async (request, url) => {
        if (url.pathname === "/api/oauth/token") {
          bodies.push(await request.text())
          return Response.json({ access_token: "own-access", refresh_token: "own-refresh", expires_in: 900 })
        }
        return Response.json({})
      })
      const hooks = await KimiAuthPlugin(makeInput().input, { ...serverOptions(server), credentialsPath })
      const opts = await hooks.auth!.loader!(async () => oauthAuth({ expires: Date.now() - 1000 }), emptyProvider)
      await opts.fetch!(new URL("/coding/v1/chat/completions", server.url))
      expect(bodies[0]).toContain("refresh_token=refresh-token")
      expect(await Bun.file(credentialsPath).json()).toEqual(original)
    })

    test("retains rotated credentials across requests when both stores fail", async () => {
      await using tmp = await tmpdir()
      await Bun.write(path.join(tmp.path, "blocked"), "This is a file, not a credentials directory")
      const captured: string[] = []
      let refreshCalls = 0
      using server = makeServer((_request, url) => {
        if (url.pathname === "/api/oauth/token") {
          refreshCalls += 1
          if (refreshCalls > 1) return Response.json({ error: "invalid_grant" }, { status: 400 })
          return Response.json({ access_token: "cached-access", refresh_token: "cached-refresh", expires_in: 900 })
        }
        captured.push(_request.headers.get("authorization") ?? "")
        return Response.json({})
      })
      const hooks = await KimiAuthPlugin(makeInput({ failSet: true }).input, {
        ...serverOptions(server),
        credentialsPath: path.join(tmp.path, "blocked", "kimi-code.json"),
        syncCredentials: true,
      })
      const opts = await hooks.auth!.loader!(async () => oauthAuth({ expires: Date.now() - 1000 }), emptyProvider)
      await opts.fetch!(new URL("/coding/v1/chat/completions", server.url))
      await opts.fetch!(new URL("/coding/v1/chat/completions", server.url))
      expect(refreshCalls).toBe(1)
      expect(captured).toEqual(["Bearer cached-access", "Bearer cached-access"])
    })

    test("shares one refresh and its cached result between project loaders", async () => {
      const ready = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let refreshCalls = 0
      using server = makeServer(async (_request, url) => {
        if (url.pathname === "/api/oauth/token") {
          refreshCalls += 1
          ready.resolve()
          await release.promise
          return Response.json({ access_token: "shared-access", refresh_token: "shared-refresh", expires_in: 900 })
        }
        return Response.json({})
      })
      const input = makeInput()
      const options = serverOptions(server)
      const first = await KimiAuthPlugin(input.input, options)
      const second = await KimiAuthPlugin(input.input, options)
      const stored = oauthAuth({ expires: Date.now() - 1000 })
      const loaders = await Promise.all([
        first.auth!.loader!(async () => stored, emptyProvider),
        second.auth!.loader!(async () => stored, emptyProvider),
      ])
      const requests = Promise.all(
        loaders.map((loader) => loader.fetch!(new URL("/coding/v1/chat/completions", server.url))),
      )
      await ready.promise
      release.resolve()
      await requests
      await loaders[1].fetch!(new URL("/coding/v1/chat/completions", server.url))
      expect(refreshCalls).toBe(1)
      expect(input.setCalls).toHaveLength(1)
    })

    test("requires a new provider instance after OAuth changes to an API key", async () => {
      let stored: Auth = oauthAuth()
      let requests = 0
      using server = makeServer(() => {
        requests += 1
        return Response.json({})
      })
      const hooks = await KimiAuthPlugin(makeInput().input, serverOptions(server))
      const opts = await hooks.auth!.loader!(async () => stored, emptyProvider)
      stored = { type: "api", key: "new-api-key" }
      await expect(
        opts.fetch!(new URL("/coding/v1/chat/completions", server.url), {
          headers: { Authorization: `Bearer ${OAUTH_DUMMY_KEY}` },
        }),
      ).rejects.toThrow("Reconnect the provider")
      expect(requests).toBe(0)
      expect(await hooks.auth!.loader!(async () => stored, emptyProvider)).toEqual({})
    })

    test("does not restore a removed login or send an old token", async () => {
      let stored: Auth | undefined = oauthAuth()
      let requests = 0
      using server = makeServer(() => {
        requests += 1
        return Response.json({})
      })
      const hooks = await KimiAuthPlugin(makeInput().input, serverOptions(server))
      const opts = await hooks.auth!.loader!(async () => stored!, emptyProvider)
      stored = undefined
      await expect(opts.fetch!(new URL("/coding/v1/chat/completions", server.url))).rejects.toThrow(
        "Reconnect the provider",
      )
      expect(requests).toBe(0)
    })

    test("does not overwrite authentication changed during refresh", async () => {
      const state: { auth: Auth } = { auth: oauthAuth({ expires: Date.now() - 1000 }) }
      let completions = 0
      const input = makeInput()
      using server = makeServer((_request, url) => {
        if (url.pathname === "/api/oauth/token") {
          state.auth = { type: "api", key: "new-api-key" }
          return Response.json({
            access_token: "old-account-access",
            refresh_token: "old-account-refresh",
            expires_in: 900,
          })
        }
        completions += 1
        return Response.json({})
      })
      const hooks = await KimiAuthPlugin(input.input, serverOptions(server))
      const opts = await hooks.auth!.loader!(async () => state.auth, emptyProvider)
      await expect(opts.fetch!(new URL("/coding/v1/chat/completions", server.url))).rejects.toThrow(
        "changed during refresh",
      )
      expect(input.setCalls).toHaveLength(0)
      expect(completions).toBe(0)
      expect(state.auth).toEqual({ type: "api", key: "new-api-key" })
    })
  })

  describe("provider.models", () => {
    const provider = { models: { "some-old-model": { id: "x" } } } as unknown as Provider

    test("keeps existing models for api auth", async () => {
      const hooks = await KimiAuthPlugin(makeInput().input)
      const models = await hooks.provider!.models!(provider, { auth: { type: "api", key: "sk" } })
      expect(models).toEqual(provider.models)
    })

    test("swaps in the coding catalog for oauth auth", async () => {
      const hooks = await KimiAuthPlugin(makeInput().input)
      const models = await hooks.provider!.models!(provider, { auth: oauthAuth() })
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
