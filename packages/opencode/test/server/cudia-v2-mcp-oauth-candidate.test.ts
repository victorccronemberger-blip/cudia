import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST

type ToolDefinition = {
  readonly type?: string
  readonly function?: { readonly name?: string; readonly description?: string; readonly parameters?: unknown }
}

type CapturedRequest = {
  readonly messages: readonly { readonly role?: string; readonly content?: unknown }[]
  readonly tools?: readonly ToolDefinition[]
}

type MCPRequest = {
  readonly id?: number | string
  readonly method: string
  readonly params?: {
    readonly name?: string
    readonly arguments?: Record<string, unknown>
  }
}

type OAuthRequest = { readonly path: string; readonly method: string; readonly grant?: string }

test.skipIf(candidate === undefined)(
  "compiled CUDIA candidate authorizes and renews MCP credentials once without replaying failed calls",
  async () => {
    if (!candidate || !path.isAbsolute(candidate))
      throw new Error("CUDIA_CANDIDATE_TEST must be an absolute executable path")
    if (!(await Bun.file(candidate).exists())) throw new Error("CUDIA_CANDIDATE_TEST executable does not exist")

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cudia-v2-mcp-candidate-"))
    const workspace = path.join(tempRoot, "workspace")
    const config = path.join(tempRoot, "config")
    const data = path.join(tempRoot, "data")
    const cache = path.join(tempRoot, "cache")
    const state = path.join(tempRoot, "state")
    const captured: CapturedRequest[] = []
    const mcpCalls: Array<{ readonly name?: string; readonly arguments?: Record<string, unknown> }> = []
    const oauthRequests: OAuthRequest[] = []
    const mcpAuthorizations: Array<string | null> = []
    let mcpOrigin = ""
    let rejectAfterSideEffect = false
    let provider: ReturnType<typeof Bun.serve> | undefined
    let mcp: ReturnType<typeof Bun.serve> | undefined
    let child: ReturnType<typeof Bun.spawn> | undefined

    try {
      await Promise.all(
        [workspace, config, data, cache, state].map((directory) => mkdir(directory, { recursive: true })),
      )
      mcp = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname !== "/mcp") {
            const form = url.pathname === "/token" ? new URLSearchParams(await request.text()) : undefined
            const grant = form?.get("grant_type") ?? undefined
            oauthRequests.push({ path: url.pathname, method: request.method, grant })
            if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
              return Response.json({
                resource: `${mcpOrigin}/mcp`,
                authorization_servers: [mcpOrigin],
                scopes_supported: ["mcp"],
              })
            if (url.pathname === "/.well-known/oauth-authorization-server")
              return Response.json({
                issuer: mcpOrigin,
                authorization_endpoint: `${mcpOrigin}/authorize`,
                token_endpoint: `${mcpOrigin}/token`,
                response_types_supported: ["code"],
                grant_types_supported: ["authorization_code", "refresh_token"],
                token_endpoint_auth_methods_supported: ["none"],
                code_challenge_methods_supported: ["S256"],
                authorization_response_iss_parameter_supported: true,
              })
            if (url.pathname === "/token") {
              if (grant === "refresh_token" && form?.get("refresh_token") !== "candidate-refresh-secret")
                return Response.json({ error: "invalid_grant" }, { status: 400 })
              return Response.json({
                access_token: grant === "refresh_token" ? "candidate-access-secret" : "candidate-initial-access-secret",
                refresh_token:
                  grant === "refresh_token" ? "candidate-rotated-refresh-secret" : "candidate-refresh-secret",
                expires_in: grant === "refresh_token" ? 3600 : 0,
                token_type: "Bearer",
              })
            }
            return new Response("Not found", { status: 404 })
          }
          const authorization = request.headers.get("authorization")
          if (request.method === "GET") {
            if (authorization === "Bearer candidate-access-secret") return new Response(null, { status: 405 })
            return oauthChallenge(mcpOrigin)
          }
          if (authorization !== "Bearer candidate-access-secret") return oauthChallenge(mcpOrigin)
          mcpAuthorizations.push(authorization)
          const message = (await request.json()) as MCPRequest
          if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
          if (message.method === "initialize")
            return mcpResponse(message, {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "cudia-fixture", version: "1.0.0" },
            })
          if (message.method === "tools/list")
            return mcpResponse(message, {
              tools: [
                {
                  name: "echo",
                  description: "Echo a short value",
                  inputSchema: {
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                    additionalProperties: false,
                  },
                  outputSchema: {
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                    additionalProperties: false,
                  },
                },
              ],
            })
          if (message.method === "tools/call") {
            mcpCalls.push({ name: message.params?.name, arguments: message.params?.arguments })
            if (rejectAfterSideEffect) return new Response("Rejected after side effect", { status: 401 })
            const value = message.params?.arguments?.value
            return mcpResponse(message, {
              content: [{ type: "text", text: `MCP_ECHO_RESULT:${String(value)}` }],
              structuredContent: { value },
            })
          }
          return new Response(null, { status: 202 })
        },
      })
      mcpOrigin = `http://127.0.0.1:${mcp.port}`

      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
          const input = (await request.json()) as {
            messages?: CapturedRequest["messages"]
            tools?: CapturedRequest["tools"]
          }
          const capturedRequest = { messages: input.messages ?? [], tools: input.tools }
          captured.push(capturedRequest)

          if (captured.length === 1) return toolCall("mcp", { operation: "connect", server: "fixture" }, "connect")
          if (captured.length === 2)
            return toolCall("mcp", { operation: "expose", server: "fixture", names: ["echo"] }, "expose")
          if (captured.length === 3) {
            const dynamic = capturedRequest.tools?.find((tool) => {
              const name = tool.function?.name
              return name?.startsWith("mcp_") && name.endsWith("_echo")
            })?.function?.name
            if (!dynamic) return completion("DYNAMIC_MCP_TOOL_MISSING")
            rejectAfterSideEffect = true
            return toolCall(dynamic, { value: "from-provider" }, "echo")
          }
          return completion("MCP_OAUTH_CALL_FINISHED")
        },
      })

      const configPath = path.join(config, "opencode.json")
      await writeFile(
        configPath,
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          snapshot: false,
          model: "smoke/smoke",
          permission: { "mcp.*": "allow" },
          mcp: {
            fixture: {
              type: "remote",
              url: `${mcpOrigin}/mcp`,
              enabled: false,
              oauth: { clientId: "candidate-client", redirectUri: "http://127.0.0.1:0/callback", scope: "mcp" },
            },
          },
          provider: {
            smoke: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
              models: { smoke: { name: "CUDIA local fixture", limit: { context: 40000, output: 4096 } } },
            },
          },
        }),
        "utf8",
      )

      const port = await availablePort()
      const environment = {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        WINDIR: process.env.WINDIR ?? "",
        TEMP: tempRoot,
        TMP: tempRoot,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
        XDG_CACHE_HOME: cache,
        XDG_STATE_HOME: state,
        APPDATA: config,
        LOCALAPPDATA: data,
        OPENCODE_TEST_HOME: tempRoot,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_DB: path.join(data, "candidate.sqlite"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_SERVER_USERNAME: "",
        OPENCODE_EXPERIMENTAL: "0",
      }
      child = Bun.spawn({
        cmd: [candidate, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
        cwd: workspace,
        env: environment,
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })

      const baseURL = `http://127.0.0.1:${port}`
      await poll(
        async () => {
          const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1_000) }).catch(
            () => undefined,
          )
          return response?.status === 200
        },
        child,
        "candidate server did not become healthy",
      )

      const location = locationQuery(workspace)
      const listed = await fetch(`${baseURL}/api/integration${location}`)
      expect(listed.status).toBe(200)
      const integrations = (await listed.json()) as {
        data: Array<{
          readonly id: string
          readonly name: string
          readonly methods: Array<{ id: string; type: string }>
        }>
      }
      expect(JSON.stringify(integrations)).not.toContain("candidate-access-secret")
      expect(JSON.stringify(integrations)).not.toContain("candidate-refresh-secret")
      const mcpIntegration = integrations.data.find((integration) => integration.name === "MCP: fixture")
      const oauthMethod = mcpIntegration?.methods.find((method) => method.type === "oauth")
      expect(oauthMethod).toBeDefined()
      expect(oauthRequests).toHaveLength(0)

      const challenged = await fetch(`${baseURL}/api/mcp/fixture/connect${location}`, { method: "POST" })
      expect(challenged.status).toBe(400)
      expect(await challenged.text()).toContain("mcp_authentication_required")
      expect(oauthRequests).toHaveLength(0)
      expect(((await (await fetch(`${baseURL}/api/mcp${location}`)).json()) as { data: unknown }).data).toMatchObject([
        { name: "fixture", status: "authentication_required", toolCount: 0, exposureCount: 0 },
      ])

      const started = await fetch(
        `${baseURL}/api/integration/${encodeURIComponent(mcpIntegration!.id)}/connect/oauth${location}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ methodID: oauthMethod!.id, inputs: {} }),
        },
      )
      if (!started.ok)
        throw new Error(
          `OAuth start failed (${started.status}): ${await started.text()}; requests=${JSON.stringify(oauthRequests)}`,
        )
      expect(started.status).toBe(200)
      const attemptResponse = (await started.json()) as {
        data: { readonly attemptID: string; readonly url: string; readonly mode: string }
      }
      expect(attemptResponse.data.mode).toBe("auto")
      const authorizationURL = new URL(attemptResponse.data.url)
      const callbackURL = new URL(authorizationURL.searchParams.get("redirect_uri") ?? "")
      callbackURL.searchParams.set("code", "candidate-code")
      callbackURL.searchParams.set("state", authorizationURL.searchParams.get("state") ?? "")
      callbackURL.searchParams.set("iss", mcpOrigin)
      const callback = await fetch(callbackURL)
      expect(callback.status).toBe(200)
      const attempt = await pollValue(
        async () => {
          const response = await fetch(
            `${baseURL}/api/integration/attempt/${encodeURIComponent(attemptResponse.data.attemptID)}${location}`,
          )
          if (!response.ok) return undefined
          const payload = (await response.json()) as { data: { readonly status: string } }
          return payload.data.status === "complete" ? payload.data : undefined
        },
        child,
        "OAuth attempt did not complete",
      )
      expect(attempt.status).toBe("complete")
      expect(JSON.stringify([attemptResponse, attempt])).not.toContain("candidate-access-secret")
      expect(JSON.stringify([attemptResponse, attempt])).not.toContain("candidate-refresh-secret")
      expect(oauthRequests.filter((request) => request.path === "/token").map((request) => request.grant)).toEqual([
        "authorization_code",
      ])

      // Authorization changes credentials, then the operator explicitly reconnects.
      expect(((await (await fetch(`${baseURL}/api/mcp${location}`)).json()) as { data: unknown }).data).toMatchObject([
        { name: "fixture", status: "disconnected", toolCount: 0, exposureCount: 0 },
      ])
      expect((await fetch(`${baseURL}/api/mcp/fixture/connect${location}`, { method: "POST" })).status).toBe(204)
      expect(((await (await fetch(`${baseURL}/api/mcp${location}`)).json()) as { data: unknown }).data).toMatchObject([
        { name: "fixture", status: "connected", toolCount: 1, exposureCount: 0 },
      ])

      const sessionID = await createSession(baseURL, workspace)
      const prompt = await fetch(`${baseURL}/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: { text: "Connect to fixture, search for echo, expose echo, and call it." } }),
      })
      expect(prompt.status).toBe(200)
      await waitForIdle(baseURL, sessionID, 4, captured, child)

      expect(captured).toHaveLength(4)
      const namesBeforeExposure = captured
        .slice(0, 2)
        .map((request) => request.tools?.map((tool) => tool.function?.name) ?? [])
      expect(
        namesBeforeExposure.every((names) =>
          names.every((name) => !name?.startsWith("mcp_") || !name.endsWith("_echo")),
        ),
      ).toBe(true)
      expect(JSON.stringify(captured[0]?.messages)).not.toContain("Echo a short value")
      expect(JSON.stringify(captured[0]?.messages)).not.toContain("mcp_")
      const exposedName = captured[2]?.tools?.find((tool) => {
        const name = tool.function?.name
        return name?.startsWith("mcp_") && name.endsWith("_echo")
      })?.function?.name
      expect(exposedName).toBeDefined()
      expect(mcpCalls).toEqual([{ name: "echo", arguments: { value: "from-provider" } }])
      expect(mcpCalls).toHaveLength(1)
      expect(mcpAuthorizations.length).toBeGreaterThan(0)
      expect(mcpAuthorizations.every((authorization) => authorization === "Bearer candidate-access-secret")).toBe(true)
      expect(oauthRequests.filter((request) => request.path === "/token").map((request) => request.grant)).toEqual([
        "authorization_code",
        "refresh_token",
      ])
      expect(oauthRequests.some((request) => request.path === "/authorize")).toBe(false)
    } finally {
      provider?.stop(true)
      mcp?.stop(true)
      if (child && child.exitCode === null) {
        child.kill()
        await child.exited
      }
      const root = path.resolve(tempRoot)
      const temp = path.resolve(os.tmpdir())
      const prefix = temp.endsWith(path.sep) ? temp : `${temp}${path.sep}`
      if (!root.toLowerCase().startsWith(prefix.toLowerCase()))
        throw new Error("Refusing to remove a path outside the temporary directory")
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
)

function mcpResponse(request: MCPRequest, result: unknown) {
  return Response.json(
    { jsonrpc: "2.0", id: request.id, result },
    { headers: { "mcp-session-id": "cudia-mcp-candidate" } },
  )
}

function oauthChallenge(origin: string) {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
    },
  })
}

function locationQuery(directory: string) {
  return `?${new URLSearchParams({ "location[directory]": directory })}`
}

function toolCall(name: string, args: Record<string, unknown>, id: string) {
  return stream([
    { delta: { role: "assistant" } },
    {
      delta: {
        tool_calls: [
          { index: 0, id: `call-${id}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      },
    },
    { delta: {}, finish_reason: "tool_calls" },
  ])
}

function completion(content: string) {
  return stream([{ delta: { role: "assistant", content } }, { delta: {}, finish_reason: "stop" }])
}

function stream(chunks: ReadonlyArray<Record<string, unknown>>) {
  const values = chunks.map((chunk) => ({
    id: "chatcmpl-cudia-mcp-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "smoke",
    choices: [{ index: 0, ...chunk }],
  }))
  return new Response(`${values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

async function createSession(baseURL: string, workspace: string) {
  const created = await fetch(`${baseURL}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: { providerID: "smoke", id: "smoke" }, location: { directory: workspace } }),
  })
  expect(created.status).toBe(200)
  return ((await created.json()) as { data: { id: string } }).data.id
}

async function availablePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not reserve a candidate server port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}

async function poll(
  check: () => Promise<boolean>,
  child: ReturnType<typeof Bun.spawn>,
  message: string,
  timeout = 20_000,
) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${message} (candidate exited with code ${child.exitCode})`)
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(message)
}

async function pollValue<A>(
  check: () => Promise<A | undefined>,
  child: ReturnType<typeof Bun.spawn>,
  message: string,
  timeout = 20_000,
): Promise<A> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${message} (candidate exited with code ${child.exitCode})`)
    const value = await check()
    if (value !== undefined) return value
    await Bun.sleep(100)
  }
  throw new Error(message)
}

async function waitForIdle(
  baseURL: string,
  sessionID: string,
  expectedRequests: number,
  captured: readonly CapturedRequest[],
  child: ReturnType<typeof Bun.spawn>,
) {
  await poll(
    async () => {
      if (captured.length < expectedRequests) return false
      const response = await fetch(`${baseURL}/api/session/active`).catch(() => undefined)
      if (!response?.ok) return false
      const active = (await response.json()) as { data: Record<string, unknown> }
      return !Object.hasOwn(active.data, sessionID)
    },
    child,
    "session did not become idle after the local model response",
    60_000,
  )
}
