import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const candidate = process.env.CUDIA_CANDIDATE_TEST
const LARGE_URI = "fixture://document/large"
const SMALL_URI = "fixture://document/small"
const SMALL_BASE64 = "AAECA/8="
const PAGE_LIMIT = 4096
const PAGE_BUDGET = 6000
const SOURCE_SENTINEL = "SOURCE_ONLY_UNTRUSTED_4D7C"

type Message = { readonly role?: string; readonly content?: unknown; readonly [key: string]: unknown }
type NativeToolDefinition = { readonly function?: { readonly name?: string }; readonly name?: string }
type CapturedRequest = { readonly messages: readonly Message[]; readonly tools?: readonly NativeToolDefinition[] }
type MCPRequest = {
  readonly id?: number | string
  readonly method: string
  readonly params?: { readonly uri?: string }
}
type Page = {
  readonly messageID: string
  readonly callID: string
  readonly source: string
  readonly text: string
  readonly offset: number
  readonly nextOffset: number | null
  readonly complete: boolean
  readonly totalLength: number
  readonly outputHash: string
  readonly offsetUnit: string
}

test.skipIf(candidate === undefined)(
  "compiled CUDIA candidate pages native MCP output across compaction and restart",
  async () => {
    if (!candidate || !path.isAbsolute(candidate))
      throw new Error("CUDIA_CANDIDATE_TEST must be an absolute executable path")
    if (!(await Bun.file(candidate).exists())) throw new Error("CUDIA_CANDIDATE_TEST executable does not exist")

    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cudia-v2-tool-result-candidate-"))
    const workspace = path.join(tempRoot, "workspace")
    const config = path.join(tempRoot, "config")
    const data = path.join(tempRoot, "data")
    const cache = path.join(tempRoot, "cache")
    const state = path.join(tempRoot, "state")
    const largeText =
      `\uFEFF${SOURCE_SENTINEL} quoted: \"hello\"; control:\t\u0001; unicode: 🧪 e\u0301; ` +
      "native-page-🧭 ".repeat(4600)
    const largeBlob = { uri: LARGE_URI, mimeType: "image/png", blob: "AAECAwQF/w==" }
    const smallBlob = { uri: SMALL_URI, blob: SMALL_BASE64, mimeType: "application/octet-stream" }
    const expectedProjection =
      JSON.stringify({ uri: LARGE_URI, mimeType: "text/plain" }) + "\n" + largeText + JSON.stringify(largeBlob)
    const captured: CapturedRequest[] = []
    const mcpMethods: string[] = []
    const mcpReads: string[] = []
    let provider: ReturnType<typeof Bun.serve> | undefined
    let mcp: ReturnType<typeof Bun.serve> | undefined
    let child: ReturnType<typeof Bun.spawn> | undefined
    let stage: "main" | "compact" | "resume" | "fresh" = "main"
    let mainStep: "connect" | "readLarge" | "pageLarge" | "readSmall" | "pageSmall" | "done" = "connect"
    let marker: { readonly messageID: string; readonly callID: string } | undefined
    let savedHash: string | undefined
    let mainSessionID: string | undefined
    let reconstructed = false
    let reconstructedPages = 0
    let smallStructuredPage: Page | undefined
    let resumedTailPage: Page | undefined
    let resumedEofPage: Page | undefined
    let mainCompleted = false
    let compactCompleted = false
    let freshCompleted = false

    try {
      await Promise.all(
        [workspace, config, data, cache, state].map((directory) => mkdir(directory, { recursive: true })),
      )

      // One local provider and one local MCP transport let this test exercise the actual compiled server without external services.
      mcp = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.method === "GET") return new Response(null, { status: 405 })
          if (new URL(request.url).pathname !== "/mcp") return new Response(null, { status: 404 })
          const message = (await request.json()) as MCPRequest
          mcpMethods.push(message.method)
          if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
          if (message.method === "initialize")
            return mcpResponse(message, {
              protocolVersion: "2025-03-26",
              capabilities: { resources: {} },
              serverInfo: { name: "cudia-tool-result-fixture", version: "1.0.0" },
            })
          if (message.method === "resources/read") {
            const uri = message.params?.uri ?? ""
            mcpReads.push(uri)
            if (uri === LARGE_URI)
              return mcpResponse(message, { contents: [{ uri, mimeType: "text/plain", text: largeText }, largeBlob] })
            if (uri === SMALL_URI)
              return mcpResponse(message, {
                contents: [{ uri, mimeType: "text/plain", text: "small fixture" }, smallBlob],
              })
            return mcpResponse(message, { contents: [] })
          }
          if (message.method === "resources/list")
            return mcpResponse(message, {
              resources: [
                { uri: LARGE_URI, name: "large fixture", mimeType: "text/plain" },
                { uri: SMALL_URI, name: "small fixture", mimeType: "text/plain" },
              ],
            })
          return new Response(null, { status: 202 })
        },
      })

      provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response(null, { status: 404 })
          const input = (await request.json()) as { messages?: Message[]; tools?: NativeToolDefinition[] }
          const current: CapturedRequest = { messages: input.messages ?? [], tools: input.tools }
          captured.push(current)

          if (stage === "main") {
            if (mainStep === "connect") {
              assertNoToolResult(current)
              mainStep = "readLarge"
              return toolCall("mcp", { operation: "connect", server: "fixture" }, "main-connect")
            }
            if (mainStep === "readLarge") {
              mainStep = "pageLarge"
              return toolCall("mcp", { operation: "read", server: "fixture", uri: LARGE_URI }, "main-large-read")
            }
            if (mainStep === "readSmall") {
              expect(
                strings(current.messages).some((text) => /tool_result\(.*"callID":"call-main-small-read"/.test(text)),
              ).toBe(false)
              mainStep = "pageSmall"
              return toolCall(
                "tool_result",
                { callID: "call-main-small-read", source: "structured", offset: 0, limit: PAGE_LIMIT },
                "main-small-structured",
              )
            }

            if (mainStep === "pageSmall") {
              const smallPages = findPages(current.messages, "call-main-small-read", "structured")
              smallStructuredPage = smallPages[0]
              if (!smallStructuredPage) return completion("SMALL_STRUCTURED_PAGE_MISSING")
              assertPageBudget(smallStructuredPage)
              expect(smallStructuredPage.text).toContain(SMALL_BASE64)
              expect(smallStructuredPage.complete).toBe(true)
              expect(mcpReads).toEqual([LARGE_URI, SMALL_URI])
              mainStep = "done"
              mainCompleted = true
              return completion("NATIVE_TOOL_RESULT_RECONSTRUCTION_OK")
            }

            marker ??= parseMarker(current.messages)
            if (!marker) return completion("NATIVE_RETENTION_MARKER_MISSING")
            expect(toolNames(current)).toContain("tool_result")
            expect(strings(current.messages.filter((message) => message.role === "tool")).join("\n")).toContain(
              SOURCE_SENTINEL,
            )
            expect(
              current.messages
                .filter((message) => message.role === "system")
                .map((message) => JSON.stringify(message))
                .join("\n"),
            ).not.toContain(largeText)

            const pages = findPages(current.messages, marker.callID, "text")
            const previous = pages.sort((a, b) => b.offset - a.offset)[0]
            if (!previous) {
              return toolCall(
                "tool_result",
                { ...marker, source: "text", offset: 0, limit: PAGE_LIMIT },
                "main-large-page-0",
              )
            }
            expect(previous.outputHash).toMatch(/^[\da-f]{64}$/)
            savedHash ??= previous.outputHash
            expect(previous.outputHash).toBe(savedHash)
            expect(previous.offsetUnit).toBe("utf16_code_units")
            assertPageBudget(previous)
            if (previous.nextOffset !== null)
              return toolCall(
                "tool_result",
                {
                  ...marker,
                  source: "text",
                  offset: previous.nextOffset,
                  limit: PAGE_LIMIT,
                  outputHash: previous.outputHash,
                },
                `main-large-page-${previous.nextOffset}`,
              )

            const byOffset = new Map<number, Page>()
            for (const page of findPages(
              captured.map((item) => item.messages),
              marker.callID,
              "text",
            ))
              byOffset.set(page.offset, page)
            const ordered = [...byOffset.values()].sort((a, b) => a.offset - b.offset)
            let cursor = 0
            for (const page of ordered) {
              expect(page.offset).toBe(cursor)
              expect(page.totalLength).toBe(expectedProjection.length)
              assertPageBudget(page)
              cursor += page.text.length
            }
            expect(cursor).toBe(expectedProjection.length)
            expect(ordered.map((page) => page.text).join("")).toBe(expectedProjection)
            reconstructedPages = ordered.length
            reconstructed = true
            mainStep = "readSmall"
            return toolCall("mcp", { operation: "read", server: "fixture", uri: SMALL_URI }, "main-small-read")
          }

          if (stage === "compact") {
            expect(JSON.stringify(current.messages)).not.toContain(largeText)
            compactCompleted = true
            return completion(
              `## Objective\n- Continue from retained source ${JSON.stringify(marker)} and request its saved tail.`,
            )
          }

          if (stage === "resume") {
            if (!marker || !savedHash) return completion("RESUME_MARKER_OR_HASH_MISSING")
            expect(toolNames(current)).toContain("tool_result")
            expect(JSON.stringify(current.messages)).not.toContain(largeText)
            expect(strings(current.messages).join("\n")).not.toContain(SOURCE_SENTINEL)
            const pages = findPages(current.messages, marker.callID, "text")
            const latest = pages.sort((a, b) => b.offset - a.offset)[0]
            if (!latest) {
              const tailOffset = Math.max(0, expectedProjection.length - 256)
              return toolCall(
                "tool_result",
                { ...marker, source: "text", offset: tailOffset, limit: PAGE_LIMIT, outputHash: savedHash },
                "resume-tail",
              )
            }
            assertPageBudget(latest)
            if (!resumedTailPage) {
              resumedTailPage = latest
              expect(latest.offset).toBe(Math.max(0, expectedProjection.length - 256))
              expect(latest.text).toBe(expectedProjection.slice(latest.offset))
              expect(latest.complete).toBe(true)
              expect(latest.outputHash).toBe(savedHash)
              return toolCall(
                "tool_result",
                {
                  ...marker,
                  source: "text",
                  offset: expectedProjection.length,
                  limit: PAGE_LIMIT,
                  outputHash: latest.outputHash,
                },
                "resume-eof",
              )
            }
            resumedEofPage = pages.find((page) => page.offset === expectedProjection.length)
            if (!resumedEofPage) return completion("RESUME_EOF_PAGE_MISSING")
            expect(resumedEofPage.text).toBe("")
            expect(resumedEofPage.complete).toBe(true)
            expect(resumedEofPage.nextOffset).toBeNull()
            expect(resumedEofPage.outputHash).toBe(resumedTailPage.outputHash)
            mainStep = "done"
            mainCompleted = true
            return completion("RESUME_AT_EOF_OK")
          }

          if (stage === "fresh") {
            assertNoToolResult(current)
            expect(JSON.stringify(current.messages)).not.toContain(largeText)
            freshCompleted = true
            return completion("FRESH_SESSION_ISOLATED_OK")
          }

          return completion("UNEXPECTED_PROVIDER_TURN")
        },
      })

      await writeFile(
        path.join(config, "opencode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          snapshot: false,
          compaction: { keep: { tokens: 256 }, buffer: 0 },
          model: "smoke/smoke",
          permission: { "mcp.*": "allow", tool_result: "allow" },
          mcp: { fixture: { type: "remote", url: `http://127.0.0.1:${mcp.port}/mcp`, enabled: false } },
          provider: {
            smoke: {
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: "fixture-only" },
              models: { smoke: { name: "CUDIA native fixture", limit: { context: 400000, output: 4096 } } },
            },
          },
        }),
        "utf8",
      )

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

      let port = await availablePort()
      child = startChild(candidate, port, workspace, environment)
      let baseURL = `http://127.0.0.1:${port}`
      await waitHealthy(baseURL, child)

      mainSessionID = await createSession(baseURL, workspace)
      const prompt = await postPrompt(
        baseURL,
        mainSessionID,
        "Connect to fixture and read both resources exactly once.",
      )
      expect(prompt.status).toBe(200)
      // The fake provider sets this only after it receives and validates the structured recovery page.
      await waitForIdle(baseURL, mainSessionID, child, () => mainCompleted)
      expect(reconstructed).toBe(true)
      expect(marker).toBeDefined()
      expect(mcpReads).toEqual([LARGE_URI, SMALL_URI])
      expect(mcpMethods.filter((method) => method === "resources/read")).toHaveLength(2)

      // The smaller result has no retention marker, so callID-only structured recovery must work directly.
      const structuredCall = captured.find((request) => {
        const text = JSON.stringify(request.messages)
        return text.includes("small fixture") && text.includes("tool_result")
      })
      expect(structuredCall).toBeDefined()
      expect(toolNames(structuredCall!)).toContain("tool_result")
      const smallReadPart = findSmallReadCall(captured)
      expect(smallReadPart).toBeDefined()

      // Manual compaction asks the local fake provider for a checkpoint containing only the goal and saved reference.
      stage = "compact"
      const compacted = await fetch(`${baseURL}/api/session/${mainSessionID}/compact`, { method: "POST" })
      expect(compacted.status).toBe(204)
      await waitForIdle(baseURL, mainSessionID, child, () => compactCompleted)
      const history = await fetch(`${baseURL}/api/session/${mainSessionID}/message?order=asc`)
      expect(history.status).toBe(200)
      const checkpoints = ((await history.json()) as { data: { type: string; summary?: string }[] }).data.filter(
        (message) => message.type === "compaction",
      )
      expect(checkpoints).toHaveLength(1)
      expect(checkpoints[0]?.summary).toContain("## Objective")
      expect(checkpoints[0]?.summary).toContain(marker!.callID)
      expect(checkpoints[0]?.summary).not.toContain(largeText)
      expect(checkpoints[0]?.summary).not.toContain(SOURCE_SENTINEL)
      const compactedContext = await fetch(`${baseURL}/api/session/${mainSessionID}/context`)
      expect(compactedContext.status).toBe(200)
      const activeContext = ((await compactedContext.json()) as { data: { type: string }[] }).data
      expect(activeContext.filter((message) => message.type === "assistant")).toEqual([])

      // Only the child started for this isolated temp root is stopped. The database and provider fixtures survive it.
      child.kill()
      await child.exited
      child = undefined
      port = await availablePort()
      child = startChild(candidate, port, workspace, environment)
      baseURL = `http://127.0.0.1:${port}`
      await waitHealthy(baseURL, child)

      stage = "resume"
      const resume = await postPrompt(
        baseURL,
        mainSessionID,
        "Use the saved reference to fetch the final window and EOF page.",
      )
      expect(resume.status).toBe(200)
      await waitForIdle(baseURL, mainSessionID, child, () => resumedEofPage !== undefined)
      expect(resumedTailPage).toBeDefined()
      expect(resumedEofPage).toBeDefined()
      expect(mcpReads).toEqual([LARGE_URI, SMALL_URI])

      stage = "fresh"
      const freshSessionID = await createSession(baseURL, workspace)
      const freshPrompt = await postPrompt(baseURL, freshSessionID, "Reply normally without tools.")
      expect(freshPrompt.status).toBe(200)
      await waitForIdle(baseURL, freshSessionID, child, () => freshCompleted)
      const freshRequest = captured.at(-1)!
      assertNoToolResult(freshRequest)
      expect(JSON.stringify(freshRequest.messages)).not.toContain(marker!.callID)
      expect(JSON.stringify(freshRequest.messages)).not.toContain(largeText)
      for (const request of captured)
        expect(strings(request.messages.filter((message) => message.role === "system")).join("\n")).not.toContain(
          SOURCE_SENTINEL,
        )
      console.info(
        "compiled tool-result recovery",
        JSON.stringify({
          providerTurns: captured.length,
          projectionBytes: Buffer.byteLength(expectedProjection),
          reconstructedPages,
          producerReads: mcpReads.length,
          resumedPages: [resumedTailPage, resumedEofPage].filter(Boolean).length,
        }),
      )
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

function assertNoToolResult(request: CapturedRequest) {
  expect(toolNames(request)).not.toContain("tool_result")
}

function toolNames(request: CapturedRequest) {
  return (request.tools ?? []).map((tool) => tool.function?.name ?? tool.name).filter((name): name is string => !!name)
}

function findPages(values: unknown, callID: string, source: string): Page[] {
  const found = new Map<string, Page>()
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      try {
        visit(JSON.parse(value))
      } catch {
        return
      }
      return
    }
    if (!value || typeof value !== "object") return
    if (
      "messageID" in value &&
      "callID" in value &&
      "source" in value &&
      "text" in value &&
      "offset" in value &&
      "outputHash" in value &&
      (value as Page).callID === callID &&
      (value as Page).source === source
    ) {
      const page = value as Page
      found.set(`${page.offset}:${page.outputHash}`, page)
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    for (const child of Object.values(value)) visit(child)
  }
  visit(values)
  return [...found.values()]
}

function strings(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return [value, ...strings(JSON.parse(value))]
    } catch {
      return [value]
    }
  }
  if (!value || typeof value !== "object") return []
  return Object.values(value).flatMap(strings)
}

function parseMarker(messages: readonly Message[]) {
  for (const text of strings(messages)) {
    const match = text.match(/tool_result\((\{"messageID":"[^"]+","callID":"[^"]+"\})\)/)
    if (!match) continue
    const value = JSON.parse(match[1]!) as { messageID?: unknown; callID?: unknown }
    if (typeof value.messageID === "string" && typeof value.callID === "string")
      return { messageID: value.messageID, callID: value.callID }
  }
  return undefined
}

function assertPageBudget(page: Page) {
  expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(PAGE_BUDGET)
}

function findSmallReadCall(captured: CapturedRequest[]) {
  for (const request of captured) {
    const pages = findPages(request.messages, "call-main-small-read", "structured")
    if (pages.length) return pages[0]
  }
  return undefined
}

function mcpResponse(request: MCPRequest, result: unknown) {
  return Response.json(
    { jsonrpc: "2.0", id: request.id, result },
    { headers: { "mcp-session-id": "cudia-tool-result" } },
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
    id: "chatcmpl-cudia-tool-result-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "smoke",
    choices: [{ index: 0, ...chunk }],
  }))
  return new Response(`${values.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

function startChild(executable: string, port: number, workspace: string, environment: Record<string, string>) {
  return Bun.spawn({
    cmd: [executable, "serve", "--hostname", "127.0.0.1", "--port", String(port)],
    cwd: workspace,
    env: environment,
    stdout: "ignore",
    stderr: "ignore",
    windowsHide: true,
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

async function postPrompt(baseURL: string, sessionID: string, text: string) {
  return fetch(`${baseURL}/api/session/${sessionID}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: { text } }),
  })
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

async function waitHealthy(baseURL: string, child: ReturnType<typeof Bun.spawn>) {
  await poll(
    async () =>
      (await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1_000) }).catch(() => undefined))?.status ===
      200,
    child,
    "candidate server did not become healthy",
  )
}

async function poll(check: () => Promise<boolean>, child: ReturnType<typeof Bun.spawn>, message: string) {
  const deadline = Date.now() + 60_000
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
  child: ReturnType<typeof Bun.spawn>,
  completed: () => boolean,
) {
  await poll(
    async () => {
      if (!completed()) return false
      const response = await fetch(`${baseURL}/api/session/active`).catch(() => undefined)
      if (!response?.ok) return false
      const active = (await response.json()) as { data: Record<string, unknown> }
      return !Object.hasOwn(active.data, sessionID)
    },
    child,
    "session did not become idle after the local model response",
  )
}
