import { describe, expect, it } from "bun:test"
import { Effect, Fiber } from "effect"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve, sep } from "node:path"
import { MCPClient } from "../src/mcp/client"
import { ConfigMCP } from "../src/config/mcp"
import { load } from "../src/tool/json-input"
import type { Compiler } from "../src/tool/json-input"

const fixture = join(import.meta.dir, "mcp-fixtures", "stdio.js")
const authorization = "Bearer fixture-secret"

describe("MCP client adapter", () => {
  it("returns exact cached server instructions without an RPC and keeps them out of catalogs and call results", async () => {
    const values = ['Quoted "guidance"\nSecond line with Unicode: ação 🌱', "", undefined] as const
    const compiler = await Effect.runPromise(load())
    for (const instructions of values) {
      const server = httpFixture({ instructions })
      try {
        const result = await Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const client = yield* MCPClient.open({
                server: new ConfigMCP.Remote({ type: "remote", url: server.url, headers: { authorization } }),
                directory: process.cwd(),
                timeout: { startup: 2_000, request: 2_000 },
                compiler,
                onClose: () => {},
                onToolsChanged: () => {},
              })
              const first = yield* client.instructions()
              const second = yield* client.instructions()
              expect(server.posts).toEqual(["initialize", "notifications/initialized"])
              const tools = yield* client.list()
              const call = yield* client.call("echo", { value: "cached" })
              return { first, second, tools, call }
            }),
          ),
        )
        expect(result.first).toBe(instructions)
        expect(result.second).toBe(instructions)
        expect(JSON.stringify(result.tools)).not.toContain("instructions")
        expect(JSON.stringify(result.call)).not.toContain("instructions")
        expect(server.posts).toEqual(["initialize", "notifications/initialized", "tools/list", "tools/call"])
      } finally {
        await server.stop()
      }
    }
  })

  it("initializes over Streamable HTTP, keeps tool-list changes manual, and closes its transport", async () => {
    const server = httpFixture({ listChangedOnCall: true })
    let closeCount = 0
    let changeCount = 0
    const compiler = await Effect.runPromise(load())
    try {
      const opening = MCPClient.open({
        server: new ConfigMCP.Remote({
          type: "remote",
          url: server.url,
          headers: { authorization },
        }),
        directory: process.cwd(),
        timeout: { startup: 2_000, request: 2_000 },
        compiler,
        onClose: () => closeCount++,
        onToolsChanged: () => changeCount++,
      })
      expect(server.posts).toHaveLength(0)

      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* opening
            const tools = yield* client.list()
            const call = yield* client.call("echo", { value: "works" })
            return { tools, call }
          }),
        ),
      )
      expect(result.tools.map((tool) => tool.name)).toEqual(["echo"])
      expect(result.call.structuredContent).toEqual({ value: "works" })
      expect(changeCount).toBe(1)
      expect(server.posts.filter((method) => method === "tools/list")).toHaveLength(1)
      expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)
      expect(server.authorized).toBeGreaterThan(0)
      expect(closeCount).toBe(1)
    } finally {
      await server.stop()
    }
  })

  it("reports auth challenges without attempting OAuth or legacy SSE", async () => {
    const server = httpFixture({ unauthorized: true })
    const compiler = await Effect.runPromise(load())
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.result(
            MCPClient.open({
              server: new ConfigMCP.Remote({
                type: "remote",
                url: server.url,
                headers: { authorization },
              }),
              directory: process.cwd(),
              timeout: { startup: 1_000, request: 1_000 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            }),
          ),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("authentication_required")
      expect(server.posts).toEqual(["initialize"])
      expect(server.gets).toBe(0)
    } finally {
      await server.stop()
    }
  })

  it("falls back to legacy SSE only after a non-auth handshake rejection", async () => {
    const server = legacyFixture()
    const compiler = await Effect.runPromise(load())
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* MCPClient.open({
              server: new ConfigMCP.Remote({ type: "remote", url: server.url, headers: { authorization } }),
              directory: process.cwd(),
              timeout: { startup: 2_000, request: 2_000 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            })
            return yield* client.list()
          }),
        ),
      )
      expect(result.map((tool) => tool.name)).toEqual(["echo"])
      expect(server.gets).toBe(1)
      expect(server.posts.filter((method) => method === "initialize")).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })

  it("does not replay a tool call after a remote session expires", async () => {
    const server = httpFixture({ expireOnCall: true })
    const compiler = await Effect.runPromise(load())
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* MCPClient.open({
              server: new ConfigMCP.Remote({ type: "remote", url: server.url }),
              directory: process.cwd(),
              timeout: { startup: 2_000, request: 2_000 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            })
            yield* client.list()
            return yield* Effect.result(client.call("echo", { value: "once" }))
          }),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("request")
      expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)
      expect(server.posts.filter((method) => method === "initialize")).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })

  it("times out a pending tool request without replaying it", async () => {
    const server = httpFixture({ delayCallMs: 300 })
    const compiler = await Effect.runPromise(load())
    try {
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* MCPClient.open({
              server: new ConfigMCP.Remote({ type: "remote", url: server.url }),
              directory: process.cwd(),
              timeout: { startup: 2_000, request: 50 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            })
            yield* client.list()
            return yield* Effect.result(client.call("echo", { value: "once" }))
          }),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("timeout")
      expect(server.posts.filter((method) => method === "tools/call")).toHaveLength(1)
      expect(server.posts.filter((method) => method === "initialize")).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })

  it("uses SDK output validation lazily and closes an owned stdio process", async () => {
    let compileCount = 0
    const actualCompiler = await Effect.runPromise(load())
    const compiler: Compiler = {
      compile: (raw) => {
        compileCount++
        return actualCompiler.compile(raw)
      },
    }
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* MCPClient.open({
            server: new ConfigMCP.Local({ type: "local", command: [process.execPath, fixture] }),
            directory: process.cwd(),
            timeout: { startup: 5_000, request: 2_000 },
            compiler,
            onClose: () => {},
            onToolsChanged: () => {},
          })
          const tools = yield* client.list()
          expect(compileCount).toBe(0)
          const call = yield* client.call("echo", { value: "stdio" })
          expect(compileCount).toBe(1)
          return { tools, call }
        }),
      ),
    )
    expect(result.tools.map((tool) => tool.name)).toEqual(["echo"])
    expect(result.call.structuredContent).toEqual({ value: "stdio" })
  })

  it("drains stdio stderr and joins a child interrupted during initialization", async () => {
    await withTempDirectory(async (directory) => {
      const pidFile = join(directory, "pid.txt")
      const compiler = await Effect.runPromise(load())
      const fiber = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const opening = yield* MCPClient.open({
              server: new ConfigMCP.Local({
                type: "local",
                command: [process.execPath, fixture, "--hang-initialize", `--pid-file=${pidFile}`],
              }),
              directory,
              timeout: { startup: 10_000, request: 2_000 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            }).pipe(Effect.forkChild)
            yield* Effect.promise(() => waitForFile(pidFile))
            const pid = Number(yield* Effect.promise(() => readFile(pidFile, "utf8")))
            yield* Fiber.interrupt(opening)
            return pid
          }),
        ),
      )
      expect(Number.isInteger(fiber)).toBe(true)
      expect(processIsRunning(fiber)).toBe(false)
    })
  })
})

function httpFixture(
  options: {
    unauthorized?: boolean
    expireOnCall?: boolean
    delayCallMs?: number
    listChangedOnCall?: boolean
    instructions?: string
  } = {},
) {
  const posts: string[] = []
  let gets = 0
  let authorized = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.method === "GET") {
        gets++
        return new Response(null, { status: 405 })
      }
      const message = (await request.json()) as MCPRequest
      posts.push(message.method)
      if (request.headers.get("authorization") === authorization) authorized++
      if (options.unauthorized) return new Response("auth", { status: 401, headers: { "www-authenticate": "Bearer" } })
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (message.method === "initialize")
        return jsonRPC(
          message,
          {
            protocolVersion: "2025-03-26",
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "fixture", version: "1.0.0" },
            ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
          },
          true,
        )
      if (message.method === "tools/list") return jsonRPC(message, { tools: [echoTool] }, true)
      if (message.method === "tools/call") {
        if (options.expireOnCall) return new Response("expired", { status: 404 })
        if (options.delayCallMs) await new Promise((resolve) => setTimeout(resolve, options.delayCallMs))
        const response = {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: "ok" }],
            structuredContent: { value: message.params?.arguments?.value },
          },
        }
        return options.listChangedOnCall
          ? Response.json([{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }, response], {
              headers: { "mcp-session-id": "fixture-session" },
            })
          : Response.json(response, { headers: { "mcp-session-id": "fixture-session" } })
      }
      return new Response(null, { status: 202 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    posts,
    get gets() {
      return gets
    },
    get authorized() {
      return authorized
    },
    stop: () => server.stop(true),
  }
}

function legacyFixture() {
  const posts: string[] = []
  let gets = 0
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  const encoder = new TextEncoder()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.method === "GET" && new URL(request.url).pathname === "/mcp") {
        gets++
        return new Response(
          new ReadableStream({
            start: (controller) => {
              streamController = controller
              controller.enqueue(encoder.encode("event: endpoint\ndata: /messages\n\n"))
            },
          }),
          { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
        )
      }
      if (request.method !== "POST") return new Response(null, { status: 405 })
      if (new URL(request.url).pathname === "/mcp") return new Response("unsupported", { status: 404 })
      const message = (await request.json()) as MCPRequest
      posts.push(message.method)
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (message.method === "initialize")
        streamController?.enqueue(
          encoder.encode(
            `event: message\ndata: ${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: "legacy", version: "1.0.0" },
              },
            })}\n\n`,
          ),
        )
      if (message.method === "tools/list")
        streamController?.enqueue(
          encoder.encode(
            `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [echoTool] } })}\n\n`,
          ),
        )
      return new Response(null, { status: 202 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    posts,
    get gets() {
      return gets
    },
    stop: () => server.stop(true),
  }
}

type MCPRequest = {
  readonly id?: number | string
  readonly method: string
  readonly params?: { readonly arguments?: Record<string, unknown> }
}

const echoTool = {
  name: "echo",
  description: "Echo a short value",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
}

function jsonRPC(request: MCPRequest, result: unknown, session = false) {
  return Response.json(
    { jsonrpc: "2.0", id: request.id, result },
    { headers: session ? { "mcp-session-id": "fixture-session" } : undefined },
  )
}

async function withTempDirectory<A>(run: (directory: string) => Promise<A>) {
  const directory = await mkdtemp(join(tmpdir(), "cudia-mcp-client-"))
  try {
    return await run(directory)
  } finally {
    const absolute = resolve(directory)
    const temporaryRoot = resolve(tmpdir())
    const relative = absolute.slice(temporaryRoot.length)
    if (
      !isAbsolute(absolute) ||
      (absolute !== temporaryRoot && !relative.startsWith(sep)) ||
      relative.includes(`..${sep}`)
    )
      throw new Error("Refusing to remove an unexpected temporary directory")
    await rm(absolute, { recursive: true, force: true })
  }
}

async function waitForFile(path: string) {
  const deadline = Date.now() + 5_000
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for the owned fixture process")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function processIsRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
