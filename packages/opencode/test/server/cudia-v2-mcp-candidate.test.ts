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
    readonly uri?: string
  }
}

test.skipIf(candidate === undefined)(
  "compiled CUDIA candidate exposes session-scoped MCP tools only after explicit exposure",
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
    const mcpReadURIs: string[] = []
    const providerCompletions: string[] = []
    const mcpPosts: string[] = []
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
          if (request.method === "GET") return new Response(null, { status: 405 })
          if (new URL(request.url).pathname !== "/mcp") return new Response(null, { status: 404 })
          const message = (await request.json()) as MCPRequest
          mcpPosts.push(message.method)
          if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
          if (message.method === "initialize")
            return mcpResponse(message, {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {}, resources: {} },
              serverInfo: { name: "cudia-fixture", version: "1.0.0" },
            })
          if (message.method === "resources/list")
            return mcpResponse(message, {
              resources: [{ uri: "fixture://document/one", name: "RESOURCE_METADATA_ONLY_document" }],
            })
          if (message.method === "resources/templates/list")
            return mcpResponse(message, {
              resourceTemplates: [{ uriTemplate: "fixture://document/{name}", name: "document-template" }],
            })
          if (message.method === "resources/read") {
            mcpReadURIs.push(message.params?.uri ?? "")
            return mcpResponse(message, {
              contents: [{ uri: "fixture://document/one", text: "MCP_RESOURCE_CONTENT_ONLY" }],
            })
          }
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
            const value = message.params?.arguments?.value
            return mcpResponse(message, {
              content: [{ type: "text", text: `MCP_ECHO_RESULT:${String(value)}` }],
              structuredContent: { value },
            })
          }
          return new Response(null, { status: 202 })
        },
      })

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
            return toolCall("mcp", { operation: "resources", server: "fixture", query: "document" }, "resources")
          if (captured.length === 3)
            return toolCall("mcp", { operation: "templates", server: "fixture", query: "document" }, "templates")
          if (captured.length === 4)
            return toolCall(
              "mcp",
              { operation: "read", server: "fixture", uri: "fixture://document/one" },
              "read-resource",
            )
          if (captured.length === 5)
            return toolCall("mcp", { operation: "search", server: "fixture", query: "echo" }, "search")
          if (captured.length === 6)
            return toolCall("mcp", { operation: "expose", server: "fixture", names: ["echo"] }, "expose")
          if (captured.length === 7) {
            const dynamic = capturedRequest.tools?.find((tool) => {
              const name = tool.function?.name
              return name?.startsWith("mcp_") && name.endsWith("_echo")
            })?.function?.name
            if (!dynamic) return completion("DYNAMIC_MCP_TOOL_MISSING")
            return toolCall(dynamic, { value: "from-provider" }, "echo")
          }
          if (captured.length === 8) {
            const result = JSON.stringify(capturedRequest.messages)
            const content =
              result.includes("MCP_ECHO_RESULT:from-provider") && result.includes("MCP_RESOURCE_CONTENT_ONLY")
                ? "MCP_DYNAMIC_CALL_AND_RESOURCE_READ_OK"
                : "MCP_RESULT_MISSING"
            providerCompletions.push(content)
            return completion(content)
          }
          return completion("SECOND_SESSION_NORMAL_STOP")
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
            fixture: { type: "remote", url: `http://127.0.0.1:${mcp.port}/mcp`, enabled: false },
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

      const locationQuery = `location%5Bdirectory%5D=${encodeURIComponent(workspace)}`
      const adminURL = `${baseURL}/api/mcp`
      const dormant = await fetch(`${adminURL}?${locationQuery}`)
      expect(dormant.status).toBe(200)
      expect(((await dormant.json()) as { data: unknown }).data).toMatchObject([
        { name: "fixture", status: "disabled", toolCount: 0, exposureCount: 0 },
      ])
      expect(mcpPosts).toEqual([])
      expect((await fetch(`${adminURL}/missing/connect?${locationQuery}`, { method: "POST" })).status).toBe(404)
      const connected = await fetch(`${adminURL}/fixture/connect?${locationQuery}`, { method: "POST" })
      expect(connected.status).toBe(204)
      expect(await connected.text()).toBe("")
      expect(mcpPosts.filter((method) => method === "initialize")).toHaveLength(1)
      expect(mcpPosts.filter((method) => method.startsWith("resources/"))).toEqual([])
      const sessionID = await createSession(baseURL, workspace)
      const prompt = await fetch(`${baseURL}/api/session/${sessionID}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: {
            text: "Connect to fixture, find the document resource and template, read fixture://document/one, search for echo, expose echo, and call it.",
          },
        }),
      })
      expect(prompt.status).toBe(200)
      await waitForIdle(baseURL, sessionID, 8, captured, child)

      expect(captured).toHaveLength(8)
      const namesBeforeExposure = captured
        .slice(0, 6)
        .map((request) => request.tools?.map((tool) => tool.function?.name) ?? [])
      expect(
        namesBeforeExposure.every((names) =>
          names.every((name) => !name?.startsWith("mcp_") || !name.endsWith("_echo")),
        ),
      ).toBe(true)
      expect(JSON.stringify(captured[0]?.messages)).not.toContain("Echo a short value")
      expect(JSON.stringify(captured[0]?.messages)).not.toContain("mcp_")
      expect(JSON.stringify(captured[0]?.messages)).not.toContain("RESOURCE_METADATA_ONLY_document")
      expect(JSON.stringify(captured[0]?.messages)).not.toContain("MCP_RESOURCE_CONTENT_ONLY")
      expect(JSON.stringify(captured[1]?.messages)).not.toContain("RESOURCE_METADATA_ONLY_document")
      expect(JSON.stringify(captured[1]?.messages)).not.toContain("MCP_RESOURCE_CONTENT_ONLY")
      expect(JSON.stringify(captured[2]?.messages)).toContain("RESOURCE_METADATA_ONLY_document")
      expect(JSON.stringify(captured[2]?.messages)).not.toContain("MCP_RESOURCE_CONTENT_ONLY")
      expect(JSON.stringify(captured[3]?.messages)).toContain("document-template")
      expect(JSON.stringify(captured[3]?.messages)).not.toContain("MCP_RESOURCE_CONTENT_ONLY")
      const readMessages = captured[4]?.messages ?? []
      expect(JSON.stringify(readMessages)).toContain("MCP_RESOURCE_CONTENT_ONLY")
      expect(
        readMessages.some(
          (message) => message.role === "tool" && JSON.stringify(message).includes("MCP_RESOURCE_CONTENT_ONLY"),
        ),
      ).toBe(true)
      expect(
        readMessages.some(
          (message) => message.role === "system" && JSON.stringify(message).includes("MCP_RESOURCE_CONTENT_ONLY"),
        ),
      ).toBe(false)
      const exposedName = captured[6]?.tools?.find((tool) => {
        const name = tool.function?.name
        return name?.startsWith("mcp_") && name.endsWith("_echo")
      })?.function?.name
      expect(exposedName).toBeDefined()
      expect(mcpCalls).toEqual([{ name: "echo", arguments: { value: "from-provider" } }])
      expect(JSON.stringify(captured[7]?.messages)).toContain("MCP_ECHO_RESULT:from-provider")
      expect(providerCompletions).toEqual(["MCP_DYNAMIC_CALL_AND_RESOURCE_READ_OK"])
      expect(mcpPosts.filter((method) => method === "resources/list")).toHaveLength(1)
      expect(mcpPosts.filter((method) => method === "resources/templates/list")).toHaveLength(1)
      expect(mcpPosts.filter((method) => method === "resources/read")).toHaveLength(1)
      expect(mcpReadURIs).toEqual(["fixture://document/one"])
      expect(mcpPosts.filter((method) => method === "initialize")).toHaveLength(1)
      expect(((await (await fetch(`${adminURL}?${locationQuery}`)).json()) as { data: unknown }).data).toMatchObject([
        { name: "fixture", status: "connected", toolCount: 1, exposureCount: 1 },
      ])

      const secondSessionID = await createSession(baseURL, workspace)
      const secondPrompt = await fetch(`${baseURL}/api/session/${secondSessionID}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: { text: "Reply normally and do not call tools." } }),
      })
      expect(secondPrompt.status).toBe(200)
      await waitForIdle(baseURL, secondSessionID, 9, captured, child)
      expect(captured).toHaveLength(9)
      const secondTools = captured[8]?.tools?.map((tool) => tool.function?.name) ?? []
      expect(secondTools).not.toContain(exposedName)
      expect(JSON.stringify(captured[8]?.messages)).not.toContain("MCP_RESOURCE_CONTENT_ONLY")
      expect(mcpCalls).toHaveLength(1)
      expect(mcpReadURIs).toEqual(["fixture://document/one"])
      expect((await fetch(`${adminURL}/fixture/disconnect?${locationQuery}`, { method: "POST" })).status).toBe(204)
      expect(((await (await fetch(`${adminURL}?${locationQuery}`)).json()) as { data: unknown }).data).toMatchObject([
        { name: "fixture", status: "disconnected", toolCount: 0, exposureCount: 0 },
      ])
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
