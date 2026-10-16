import { expect, test } from "bun:test"
import { Flag } from "@opencode-ai/core/flag/flag"
import { OpenCode } from "@opencode-ai/client/effect"
import { createRoutes } from "@opencode-ai/server/routes"
import { Context, Effect, Exit, Layer } from "effect"
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

test("MCP admin routes use location config, require auth, and connect without exposing tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "cudia-mcp-admin-"))
  const configured = join(root, "configured")
  const other = join(root, "other")
  const malformed = join(root, "malformed")
  const oauth = join(root, "oauth")
  const globalConfig = join(root, "global")
  const database = Flag.OPENCODE_DB
  const configDirectory = process.env.OPENCODE_CONFIG_DIR
  Flag.OPENCODE_DB = join(root, "opencode.sqlite")
  process.env.OPENCODE_CONFIG_DIR = globalConfig

  await Promise.all([configured, other, malformed, oauth, globalConfig].map((path) => mkdir(path)))
  const remote = httpFixture()
  const unauthorizedRemote = httpFixture({ unauthorized: true })
  const observations: ResponseObservation[] = []
  const password = "admin-fixture-password"
  const web = HttpRouter.toWebHandler(createRoutes(password).pipe(Layer.provide(HttpServer.layerServices)), {
    disableLogger: true,
  })

  try {
    await Promise.all([
      writeConfig(configured, remote.url),
      writeConfig(malformed, remote.url),
      writeConfig(oauth, unauthorizedRemote.url, true),
    ])
    const unauthenticated = await client(web, observations)
    const denied = await Effect.runPromise(
      Effect.result(unauthenticated.mcp.list({ location: { directory: configured } })),
    )
    expect(denied._tag).toBe("Failure")
    expect(observations.at(-1)?.status).toBe(401)
    expect(remote.methods).toEqual([])

    const opencode = await client(web, observations, `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`)
    expect(await Effect.runPromise(opencode.health.get())).toEqual({ healthy: true, protocol: "v2" })
    const location = { directory: configured }
    const dormant = await Effect.runPromise(opencode.mcp.list({ location }))
    expect(dormant.data).toEqual([
      expect.objectContaining({ name: "fixture", status: "disconnected", toolCount: 0, exposureCount: 0 }),
    ])
    expect(remote.methods).toEqual([])

    await Effect.runPromise(opencode.mcp.connect({ server: "fixture", location }))
    expect(observations.at(-1)?.status).toBe(204)
    expect(remote.methods).toContain("initialize")
    expect(remote.methods).toContain("tools/list")

    const connected = await Effect.runPromise(opencode.mcp.list({ location }))
    expect(connected.data).toEqual([
      expect.objectContaining({ name: "fixture", status: "connected", toolCount: 1, exposureCount: 0 }),
    ])

    await Effect.runPromise(opencode.mcp.disconnect({ server: "fixture", location }))
    expect(observations.at(-1)?.status).toBe(204)
    const disconnected = await Effect.runPromise(opencode.mcp.list({ location }))
    expect(disconnected.data).toEqual([
      expect.objectContaining({ name: "fixture", status: "disconnected", toolCount: 0, exposureCount: 0 }),
    ])

    const otherLocation = { directory: other }
    expect((await Effect.runPromise(opencode.mcp.list({ location: otherLocation }))).data).toEqual([])
    const missing = await Effect.runPromise(
      Effect.result(opencode.mcp.connect({ server: "fixture", location: otherLocation })),
    )
    expect(missing._tag).toBe("Failure")
    expect(observations.at(-1)?.status).toBe(404)

    const beforeMalformed = remote.methods.length
    const invalidName = await Effect.runPromiseExit(
      opencode.mcp.connect({ server: "\uD800", location: { directory: malformed } }),
    )
    expect(Exit.isFailure(invalidName)).toBe(true)
    expect(remote.methods).toHaveLength(beforeMalformed)

    const oauthLocation = { directory: oauth }
    const required = await Effect.runPromise(
      Effect.result(opencode.mcp.connect({ server: "fixture", location: oauthLocation })),
    )
    expect(required._tag).toBe("Failure")
    expect(observations.at(-1)?.status).toBe(400)
    expect(observations.at(-1)?.body).toContain("mcp_authentication_required")
    expect(observations.at(-1)?.body.length).toBeLessThan(512)
    expect(observations.at(-1)?.body).not.toContain("admin-fixture-password")
    expect(unauthorizedRemote.methods).toEqual(["initialize"])

    const oauthState = await Effect.runPromise(opencode.mcp.list({ location: oauthLocation }))
    expect(oauthState.data).toEqual([
      expect.objectContaining({
        name: "fixture",
        status: "authentication_required",
        toolCount: 0,
        exposureCount: 0,
        error: expect.objectContaining({ kind: "authentication_required" }),
      }),
    ])
  } finally {
    await Promise.all([remote.stop(), unauthorizedRemote.stop(), web.dispose()])
    Flag.OPENCODE_DB = database
    if (configDirectory === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = configDirectory
    Bun.gc(true)
    const target = resolve(root)
    const within = relative(resolve(tmpdir()), target)
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
      throw new Error("Refusing to remove an MCP admin fixture outside the temporary directory")
    await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
})

type ResponseObservation = { readonly status: number; readonly body: string }

async function client(
  web: ReturnType<typeof HttpRouter.toWebHandler>,
  observations: ResponseObservation[],
  authorization?: string,
) {
  const context = Context.empty() as Context.Context<unknown>
  const fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (authorization) request.headers.set("authorization", authorization)
      const response = await web.handler(request, context)
      observations.push({ status: response.status, body: await response.clone().text() })
      return response
    },
    { preconnect: () => undefined },
  ) satisfies typeof globalThis.fetch
  return Effect.runPromise(
    OpenCode.make({ baseUrl: "http://cudia.local" }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetch),
    ),
  )
}

async function writeConfig(directory: string, url: string, oauth = false) {
  const configDirectory = join(directory, ".opencode")
  await mkdir(configDirectory)
  await writeFile(
    join(configDirectory, "opencode.json"),
    JSON.stringify({
      mcp: { servers: { fixture: { type: "remote", url, ...(oauth ? {} : { oauth: false }) } } },
    }),
  )
}

function httpFixture(options: { readonly unauthorized?: boolean } = {}) {
  const methods: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.method === "GET") return new Response(null, { status: 405 })
      const message = (await request.json()) as MCPRequest
      methods.push(message.method)
      if (options.unauthorized) return new Response("auth", { status: 401, headers: { "www-authenticate": "Bearer" } })
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "admin-fixture", version: "1.0.0" },
            }
          : { tools: [echoTool] }
      return Response.json(
        { jsonrpc: "2.0", id: message.id, result },
        { headers: { "mcp-session-id": "admin-fixture-session" } },
      )
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    methods,
    stop: () => server.stop(true),
  }
}

type MCPRequest = { readonly id?: number | string; readonly method: string }

const echoTool = {
  name: "echo",
  description: "Echo a short value",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
}
