import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const source = process.env.CUDIA_SOURCE_TEST === "1"
const enabled = source || candidate !== undefined
const modelID = "mcp-demand-fixture"
const guidance = "MCP_DEMAND_GUIDANCE_MARKER"
const echoResult = "MCP_DEMAND_ECHO:from-provider"

type CapturedRequest = {
  readonly messages: readonly { readonly role?: string; readonly content?: unknown }[]
  readonly tools?: readonly {
    readonly function?: { readonly name?: string; readonly description?: string }
  }[]
}

test.skipIf(!enabled)(
  "compiled or source V1 connects configured stdio MCP only on request in both tool modes",
  async () => {
    if (candidate !== undefined && (!path.isAbsolute(candidate) || !(await Bun.file(candidate).exists())))
      throw new Error("CUDIA_CANDIDATE_TEST must name an existing absolute executable")
    if (source && !process.cwd().endsWith(path.join("packages", "opencode")))
      throw new Error("CUDIA_SOURCE_TEST must run from packages/opencode")

    await runMode(false)
    await runMode(true)
  },
  120_000,
)

async function runMode(codeMode: boolean) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "cudia-v1-mcp-demand-"))
  const workspace = path.join(temporary, "workspace")
  const config = path.join(temporary, "config")
  const data = path.join(temporary, "data")
  const cache = path.join(temporary, "cache")
  const state = path.join(temporary, "state")
  const trace = path.join(temporary, "mcp-trace.jsonl")
  const fixture = path.resolve("test/fixture/mcp-demand-stdio.js")
  const captured: CapturedRequest[] = []
  let provider: ReturnType<typeof Bun.serve> | undefined
  let child: ReturnType<typeof Bun.spawn> | undefined
  let failure: unknown
  let baseURL = ""
  let turn = 0
  let sessionID = ""
  const headers = { "content-type": "application/json", "x-opencode-directory": workspace }
  const route = (pathname: string) => {
    const url = new URL(pathname, baseURL)
    url.searchParams.set("directory", workspace)
    return url
  }

  try {
    await Promise.all([workspace, config, data, cache, state].map((directory) => mkdir(directory, { recursive: true })))
    const environment = {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      WINDIR: process.env.WINDIR ?? "",
      TEMP: temporary,
      TMP: temporary,
      XDG_CONFIG_HOME: config,
      XDG_DATA_HOME: data,
      XDG_CACHE_HOME: cache,
      XDG_STATE_HOME: state,
      APPDATA: config,
      LOCALAPPDATA: data,
      OPENCODE_TEST_HOME: temporary,
      OPENCODE_CONFIG_DIR: config,
      OPENCODE_DB: path.join(data, "candidate.sqlite"),
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_FFF: "1",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENCODE_SERVER_PASSWORD: "",
      OPENCODE_SERVER_USERNAME: "",
      OPENCODE_EXPERIMENTAL: "0",
      OPENCODE_EXPERIMENTAL_CODE_MODE: codeMode ? "1" : "0",
      CUDIA_CONTEXT_MODE: "lean",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(temporary, "no-global-git-config"),
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

    provider = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
        try {
          const input = (await request.json()) as CapturedRequest
          captured.push(input)
          const wire = JSON.stringify(input.messages)
          const system = JSON.stringify(input.messages.filter((message) => message.role === "system"))
          const definitions = JSON.stringify(input.tools ?? [])
          const traceLines = await readTrace(trace)

          if (turn === 0) {
            expect(traceLines).toEqual([])
            expect(system).not.toContain(guidance)
            expect(definitions).not.toContain(guidance)
            expect(definitions).not.toContain("MCP_DEMAND_ECHO")
            if (codeMode) {
              expect(input.tools?.map((tool) => tool.function?.name)).toContain("execute")
              return execute("return await tools.$mcp.connect({ server: 'fixture' })", "connect")
            }
            expect(input.tools?.map((tool) => tool.function?.name)).toContain("mcp")
            return toolCall("mcp", { operation: "connect", server: "fixture" }, "connect")
          }

          if (turn === 1) {
            expect(traceLines.map((item) => item.method ?? item.event)).toEqual([
              "startup",
              "initialize",
              "notifications/initialized",
              "tools/list",
            ])
            expect(system).not.toContain(guidance)
            expect(definitions).not.toContain(guidance)
            if (codeMode) {
              return execute("return await tools.$codemode.search({ query: 'fixture echo' })", "search")
            }
            expect(input.tools?.map((tool) => tool.function?.name)).toContain("fixture_echo")
            return toolCall("fixture_echo", { value: "from-provider" }, "echo")
          }

          if (turn === 2) {
            expect(system).not.toContain(guidance)
            expect(definitions).not.toContain(guidance)
            if (codeMode) {
              expect(wire).toContain("tools.fixture.echo")
              return execute("return await tools.fixture.echo({ value: 'from-provider' })", "echo")
            }
            expect(wire).toContain(echoResult)
            return toolCall("mcp", { operation: "instructions", server: "fixture" }, "instructions")
          }

          if (turn === 3) {
            expect(system).not.toContain(guidance)
            expect(definitions).not.toContain(guidance)
            if (codeMode) {
              expect(wire).toContain(echoResult)
              return execute("return await tools.$mcp.instructions({ server: 'fixture' })", "instructions")
            }
            expect(wire).toContain(guidance)
            return toolCall("mcp", { operation: "disconnect", server: "fixture" }, "disconnect")
          }

          if (turn === 4) {
            if (codeMode) {
              expect(wire).toContain(guidance)
              return execute("return await tools.$mcp.disconnect({ server: 'fixture' })", "disconnect")
            }
            expect(system).not.toContain(guidance)
            expect(definitions).not.toContain(guidance)
            expect(input.tools?.map((tool) => tool.function?.name)).not.toContain("fixture_echo")
            expect(traceLines.filter((item) => item.method === "tools/call")).toHaveLength(1)
            return completion("MCP_DEMAND_LIFECYCLE_OK")
          }

          if (turn === 5) {
            expect(system).not.toContain(guidance)
            expect(definitions).not.toContain(guidance)
            expect(definitions).not.toContain("tools.fixture.echo")
            expect(traceLines.filter((item) => item.method === "tools/call")).toHaveLength(1)
            return completion("MCP_DEMAND_LIFECYCLE_OK")
          }

          throw new Error(`Unexpected provider request ${turn}`)
        } catch (error) {
          failure = error
          return completion("MCP_DEMAND_ASSERTION_FAILED")
        } finally {
          turn++
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
        mcp: {
          fixture: {
            type: "local",
            command: [process.execPath, fixture],
            environment: { CUDIA_MCP_TRACE: trace },
          },
        },
        provider: {
          smoke: {
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
            models: { [modelID]: { name: modelID, limit: { context: 40_000, output: 4096 } } },
          },
        },
      }),
      "utf8",
    )

    const port = await availablePort()
    baseURL = `http://127.0.0.1:${port}`
    const command = source
      ? [process.execPath, path.resolve("src/index.ts"), "serve", "--hostname", "127.0.0.1", "--port", String(port)]
      : [candidate!, "serve", "--hostname", "127.0.0.1", "--port", String(port)]
    child = Bun.spawn({
      cmd: command,
      cwd: process.cwd(),
      env: environment,
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    })
    await poll(
      async () =>
        (await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined))?.ok ===
        true,
      child,
      "server did not start",
    )

    const created = await fetch(route("/session"), {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: codeMode ? "MCP demand CodeMode" : "MCP demand tools",
        agent: "build",
        model: { providerID: "smoke", id: modelID },
      }),
    })
    expect(created.status).toBe(200)
    sessionID = ((await created.json()) as { id: string }).id
    const response = await fetch(route(`/session/${sessionID}/message`), {
      method: "POST",
      headers,
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "smoke", modelID },
        parts: [
          {
            type: "text",
            text: "Connect to fixture, use its echo tool, read its guidance on request, then disconnect.",
          },
        ],
      }),
      signal: AbortSignal.timeout(90_000),
    })
    expect(response.status).toBe(200)
    if (failure !== undefined) throw failure
    expect(turn).toBe(codeMode ? 6 : 5)
    const result = (await response.json()) as {
      readonly info?: { readonly error?: unknown }
      readonly parts?: readonly { readonly type: string; readonly text?: string }[]
    }
    expect(result.info?.error).toBeUndefined()
    expect(
      result.parts
        ?.filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    ).toContain("MCP_DEMAND_LIFECYCLE_OK")
    const methods = (await readTrace(trace)).map((item) => item.method ?? item.event)
    expect(methods.slice(0, 5)).toEqual([
      "startup",
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ])
    expect(methods.slice(5)).toEqual(methods.length === 6 ? ["notifications/cancelled"] : [])
    console.info("V1 MCP demand fixture", JSON.stringify({ codeMode, turns: turn, methods }))
  } finally {
    provider?.stop(true)
    if (child && child.exitCode === null) {
      child.kill()
      await child.exited
    }
    const resolved = path.resolve(temporary)
    const temp = path.resolve(os.tmpdir())
    const prefix = temp.endsWith(path.sep) ? temp : `${temp}${path.sep}`
    if (!resolved.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error("Refusing unsafe fixture cleanup")
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
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

function execute(code: string, id: string) {
  return toolCall("execute", { code }, id)
}

function completion(content: string) {
  return stream([{ delta: { role: "assistant", content } }, { delta: {}, finish_reason: "stop" }])
}

function stream(chunks: ReadonlyArray<Record<string, unknown>>) {
  const values = chunks.map((chunk) => ({
    id: "chatcmpl-cudia-v1-mcp-demand",
    object: "chat.completion.chunk",
    created: 0,
    model: modelID,
    choices: [{ index: 0, ...chunk }],
  }))
  return new Response(`${values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

async function readTrace(file: string) {
  if (!(await Bun.file(file).exists())) return [] as Array<Record<string, unknown>>
  return (await readFile(file, "utf8"))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
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

async function poll(check: () => Promise<boolean>, child: ReturnType<typeof Bun.spawn>, message: string) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`${message} (server exited ${child.exitCode})`)
    if (await check()) return
    await Bun.sleep(100)
  }
  throw new Error(message)
}
