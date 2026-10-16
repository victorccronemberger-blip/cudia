import { expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const source = process.env.CUDIA_SOURCE_TEST === "1"
const modelID = "mcp-budget-fixture"
const count = 128
const names = Array.from({ length: count }, (_, index) => `server_${index}_${"x".repeat(80)}`)
const guidance = "MCP_BUDGET_REMOTE_GUIDANCE"

type WireRequest = {
  messages: { role: string; content: unknown; tool_calls?: { function: { name: string } }[] }[]
  tools?: { function: { name: string; description: string } }[]
}

test.skipIf(!source && !candidate)(
  "compiled or source V1 keeps many connected MCP namespaces compact on the provider wire",
  async () => {
    if (candidate && (!path.isAbsolute(candidate) || !(await Bun.file(candidate).exists())))
      throw new Error("CUDIA_CANDIDATE_TEST must name an existing absolute executable")
    if (source && !process.cwd().endsWith(path.join("packages", "opencode")))
      throw new Error("CUDIA_SOURCE_TEST must run from packages/opencode")
    const root = await mkdtemp(path.join(os.tmpdir(), "cudia-v1-mcp-budget-"))
    const workspace = path.join(root, "workspace")
    const config = path.join(root, "config")
    const data = path.join(root, "data")
    const captured: WireRequest[] = []
    const initialized: string[] = []
    const listed: string[] = []
    const called: string[] = []
    let failure: unknown
    let child: ReturnType<typeof Bun.spawn> | undefined
    let provider: ReturnType<typeof Bun.serve> | undefined
    let mcp: ReturnType<typeof Bun.serve> | undefined
    try {
      await Promise.all([workspace, config, data].map((dir) => mkdir(dir, { recursive: true })))
      mcp = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.method !== "POST") return new Response(null, { status: 405 })
          const server = new URL(request.url).searchParams.get("server")
          if (!server || !names.includes(server)) return new Response(null, { status: 404 })
          const message = (await request.json()) as {
            id?: string | number
            method: string
            params?: { name?: string }
          }
          const reply = (result: unknown) =>
            Response.json({ jsonrpc: "2.0", id: message.id, result }, { headers: { "mcp-session-id": server } })
          if (message.method === "initialize") {
            initialized.push(server)
            return reply({
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: server, version: "1" },
              instructions: guidance,
            })
          }
          if (message.method === "tools/list") {
            listed.push(server)
            return reply({ tools: [{ name: "read", description: "Read fixture", inputSchema: { type: "object" } }] })
          }
          if (message.method === "tools/call") {
            called.push(server)
            expect(message.params?.name).toBe("read")
            return reply({ content: [{ type: "text", text: "MCP_BUDGET_LAST_TOOL_OK" }] })
          }
          return new Response(null, { status: 202 })
        },
      })
      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
          try {
            const input = (await request.json()) as WireRequest
            // Auxiliary title/model requests are not turns of the tool conversation.
            if (!input.tools?.some((tool) => tool.function.name === "execute")) return completion("MCP budget fixture")
            captured.push(input)
            expect(
              input.messages.some(
                (item) =>
                  item.role === "user" &&
                  item.content === "Connect configured fixture servers, search and call the last read tool.",
              ),
            ).toBe(true)
            const execute = input.tools.find((tool) => tool.function.name === "execute")?.function.description
            expect(execute).toBeDefined()
            expect(execute).not.toContain(guidance)
            expect(JSON.stringify(input.messages.filter((item) => item.role === "system"))).not.toContain(guidance)
            if (captured.length === 1) {
              expect(input.messages.at(-1)?.role).toBe("user")
              expect(initialized).toHaveLength(0)
              expect(listed).toHaveLength(0)
              return completion({
                code: `const servers = await tools.$mcp.servers({}); const connected = await Promise.all(servers.map(async (server) => await tools.$mcp.connect({ server: server.name }))); return { connected: connected.length }`,
              })
            }
            expect(
              input.messages.some(
                (item) =>
                  item.role === "assistant" && item.tool_calls?.some((call) => call.function.name === "execute"),
              ),
            ).toBe(true)
            expect(initialized).toHaveLength(count)
            expect(listed).toHaveLength(count)
            expect(new Set(initialized).size).toBe(count)
            expect(execute).toContain(`Namespace summaries omitted (${count + 1} namespaces)`)
            expect(Buffer.byteLength(execute!)).toBeLessThan(4_000)
            for (const name of names) expect(execute).not.toContain(name)
            if (captured.length === 2) {
              const result = input.messages.findLast((item) => item.role === "tool")?.content
              expect(typeof result).toBe("string")
              expect(JSON.parse(result as string)).toEqual({ connected: count })
              return completion({
                code: `return await tools.$codemode.search({ query: "tools.${names.at(-1)}.read" })`,
              })
            }
            if (captured.length === 3) {
              expect(JSON.stringify(input.messages)).toContain(`tools.${names.at(-1)}.read`)
              return completion({ code: `return await tools.${names.at(-1)}.read({})` })
            }
            expect(captured).toHaveLength(4)
            expect(called).toEqual([names.at(-1)!])
            expect(JSON.stringify(input.messages)).toContain("MCP_BUDGET_LAST_TOOL_OK")
            return completion("MCP_BUDGET_WIRE_OK")
          } catch (error) {
            if (failure === undefined) failure = error
            return completion("MCP_BUDGET_ASSERTION_FAILED")
          }
        },
      })
      await writeFile(
        path.join(config, "opencode.json"),
        JSON.stringify({
          snapshot: false,
          formatter: false,
          lsp: false,
          model: `smoke/${modelID}`,
          mcp: Object.fromEntries(
            names.map((name) => [name, { type: "remote", url: `${mcp!.url}mcp?server=${name}` }]),
          ),
          provider: {
            smoke: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `${provider.url}v1`, apiKey: "fixture-only" },
              models: { [modelID]: { name: modelID, limit: { context: 200_000, output: 4096 } } },
            },
          },
        }),
      )
      const port = await availablePort()
      const baseURL = `http://127.0.0.1:${port}`
      const environment = {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        WINDIR: process.env.WINDIR ?? "",
        TEMP: root,
        TMP: root,
        XDG_CONFIG_HOME: config,
        XDG_DATA_HOME: data,
        XDG_CACHE_HOME: path.join(root, "cache"),
        XDG_STATE_HOME: path.join(root, "state"),
        APPDATA: config,
        LOCALAPPDATA: data,
        OPENCODE_TEST_HOME: root,
        OPENCODE_CONFIG_DIR: config,
        OPENCODE_DB: path.join(data, "candidate.sqlite"),
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_DISABLE_FFF: "1",
        OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
        OPENCODE_SERVER_PASSWORD: "",
        OPENCODE_SERVER_USERNAME: "",
        OPENCODE_EXPERIMENTAL: "0",
        OPENCODE_EXPERIMENTAL_CODE_MODE: "1",
        CUDIA_CONTEXT_MODE: "lean",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: path.join(root, "no-global-git-config"),
      }
      const git = Bun.spawn({
        cmd: ["git", "init", "--quiet"],
        cwd: workspace,
        env: environment,
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      expect(await git.exited).toBe(0)
      child = Bun.spawn({
        cmd: [
          ...(source ? [process.execPath, path.resolve("src/index.ts")] : [candidate!]),
          "serve",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
        ],
        cwd: workspace,
        env: environment,
        stdout: "ignore",
        stderr: "ignore",
        windowsHide: true,
      })
      const deadline = Date.now() + 30_000
      while (
        !(await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined))?.ok
      ) {
        if (child.exitCode !== null) throw new Error(`Server exited ${child.exitCode}`)
        if (Date.now() > deadline) throw new Error("Server did not start")
        await Bun.sleep(100)
      }
      const headers = { "content-type": "application/json", "x-opencode-directory": workspace }
      const created = await fetch(`${baseURL}/session`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          title: "MCP namespace budget",
          agent: "build",
          model: { providerID: "smoke", id: modelID },
        }),
        signal: AbortSignal.timeout(15_000),
      })
      expect(created.status).toBe(200)
      const session = (await created.json()) as { id: string }
      const response = await fetch(`${baseURL}/session/${session.id}/message`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agent: "build",
          model: { providerID: "smoke", modelID },
          parts: [{ type: "text", text: "Connect configured fixture servers, search and call the last read tool." }],
        }),
        signal: AbortSignal.timeout(90_000),
      })
      expect(response.status).toBe(200)
      if (failure !== undefined) throw failure
      const result = (await response.json()) as { info: { error?: unknown }; parts: { type: string; text?: string }[] }
      expect(result.info.error).toBeUndefined()
      expect(
        result.parts
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join(""),
      ).toContain("MCP_BUDGET_WIRE_OK")
      expect(captured).toHaveLength(4)
      console.info(
        "V1 MCP namespace budget fixture",
        JSON.stringify({
          servers: count,
          turns: captured.length,
          descriptionBytes: Buffer.byteLength(
            captured[1]!.tools!.find((tool) => tool.function.name === "execute")!.function.description,
          ),
          initialized: initialized.length,
          listed: listed.length,
          calls: called.length,
        }),
      )
    } finally {
      if (child && child.exitCode === null) {
        child.kill()
        await child.exited
      }
      provider?.stop(true)
      mcp?.stop(true)
      const resolved = path.resolve(root)
      const prefix = path.resolve(os.tmpdir()) + path.sep
      if (!resolved.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error("Refusing unsafe fixture cleanup")
      await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  },
  120_000,
)

function completion(value: string | { code: string }) {
  const delta =
    typeof value === "string"
      ? { role: "assistant", content: value }
      : {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call-budget-${crypto.randomUUID()}`,
              type: "function",
              function: { name: "execute", arguments: JSON.stringify(value) },
            },
          ],
        }
  const chunks = [{ delta }, { delta: {}, finish_reason: typeof value === "string" ? "stop" : "tool_calls" }]
  return new Response(
    chunks
      .map(
        (chunk) =>
          `data: ${JSON.stringify({
            id: "chatcmpl-mcp-budget",
            object: "chat.completion.chunk",
            created: 0,
            model: modelID,
            choices: [{ index: 0, ...chunk }],
          })}\n\n`,
      )
      .join("") + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}

async function availablePort() {
  const server = net.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Could not reserve server port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
