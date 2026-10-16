import { describe, expect, it } from "bun:test"
import { Effect, Exit, Fiber } from "effect"
import { join } from "node:path"
import { MCPClient, MAX_RESOURCE_BYTES } from "../src/mcp/client"
import type { ResourceResult } from "../src/mcp/client"
import { ConfigMCP } from "../src/config/mcp"
import { load } from "../src/tool/json-input"

const authorization = "Bearer resource-fixture"
const stdioFixture = join(import.meta.dir, "mcp-fixtures", "resources.js")

describe("MCP resource client adapter", () => {
  it("does no resource RPC at startup and distinguishes unsupported resources from empty catalogs", async () => {
    const server = fixture({ resources: false })
    try {
      const compiler = await Effect.runPromise(load())
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
            const resources = yield* client.resources()
            const templates = yield* client.templates()
            const read = yield* Effect.result(client.read("custom:opaque"))
            return { resources, templates, read }
          }),
        ),
      )

      expect(result.resources).toEqual({ supported: false, items: [] })
      expect(result.templates).toEqual({ supported: false, items: [] })
      expect(result.read._tag).toBe("Failure")
      if (result.read._tag === "Failure") expect(result.read.failure.kind).toBe("unavailable")
      expect(server.posts).toEqual(["initialize", "notifications/initialized"])
    } finally {
      await server.stop()
    }
  })

  it("collects paginated resources and templates and reports changes without refreshing automatically", async () => {
    let changed = 0
    const server = fixture({
      resources: true,
      notifyResourcesOnList: true,
      resourcePage: (cursor) =>
        cursor
          ? { resources: [{ uri: "custom://repo/two", name: "two" }] }
          : { resources: [{ uri: "custom://repo/one", name: "one" }], nextCursor: "resource-page-2" },
      templatePage: (cursor) =>
        cursor
          ? { resourceTemplates: [{ uriTemplate: "custom://repo/{name}", name: "template-two" }] }
          : {
              resourceTemplates: [{ uriTemplate: "custom://repo/{id}", name: "template-one" }],
              nextCursor: "template-page-2",
            },
    })
    try {
      const compiler = await Effect.runPromise(load())
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
              onResourcesChanged: () => changed++,
            })
            const resources = yield* client.resources()
            const templates = yield* client.templates()
            return { resources, templates }
          }),
        ),
      )

      expect(result.resources).toEqual({
        supported: true,
        items: [
          { uri: "custom://repo/one", name: "one" },
          { uri: "custom://repo/two", name: "two" },
        ],
      })
      expect(result.templates).toEqual({
        supported: true,
        items: [
          { uriTemplate: "custom://repo/{id}", name: "template-one" },
          { uriTemplate: "custom://repo/{name}", name: "template-two" },
        ],
      })
      expect(changed).toBe(1)
      expect(server.posts.filter((method) => method === "resources/list")).toHaveLength(2)
      expect(server.posts.filter((method) => method === "resources/templates/list")).toHaveLength(2)
      expect(server.authorized).toBeGreaterThan(0)
    } finally {
      await server.stop()
    }
  })

  it("preserves an empty opaque cursor instead of treating it as the end of a catalog", async () => {
    const server = fixture({
      resources: true,
      resourcePage: (cursor) =>
        cursor === undefined
          ? { resources: [{ uri: "custom:first", name: "first" }], nextCursor: "" }
          : { resources: [{ uri: "custom:second", name: "second" }] },
      templatePage: (cursor) =>
        cursor === undefined
          ? { resourceTemplates: [{ uriTemplate: "custom:first/{id}", name: "first" }], nextCursor: "" }
          : { resourceTemplates: [{ uriTemplate: "custom:second/{id}", name: "second" }] },
    })
    try {
      const compiler = await Effect.runPromise(load())
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
            return { resources: yield* client.resources(), templates: yield* client.templates() }
          }),
        ),
      )
      expect(result.resources.items.map((item) => item.uri)).toEqual(["custom:first", "custom:second"])
      expect(result.templates.items.map((item) => item.uriTemplate)).toEqual([
        "custom:first/{id}",
        "custom:second/{id}",
      ])
      expect(server.posts.filter((method) => method === "resources/list")).toHaveLength(2)
      expect(server.posts.filter((method) => method === "resources/templates/list")).toHaveLength(2)
    } finally {
      await server.stop()
    }
  })

  it("rejects repeated resource cursors and catalogs that exceed entry, byte, or page budgets", async () => {
    const loop = fixture({
      resources: true,
      resourcePage: (cursor) => ({ resources: [], nextCursor: cursor ? "again" : "again" }),
    })
    try {
      const compiler = await Effect.runPromise(load())
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* MCPClient.open({
              server: new ConfigMCP.Remote({ type: "remote", url: loop.url }),
              directory: process.cwd(),
              timeout: { startup: 2_000, request: 2_000 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            })
            return yield* Effect.result(client.resources())
          }),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("catalog")
      expect(loop.posts.filter((method) => method === "resources/list")).toHaveLength(2)
    } finally {
      await loop.stop()
    }

    const tooMany = fixture({
      resources: true,
      resourcePage: () => ({
        resources: Array.from({ length: 1_001 }, (_, index) => ({ uri: `custom:${index}`, name: `item-${index}` })),
      }),
    })
    try {
      const compiler = await Effect.runPromise(load())
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* MCPClient.open({
              server: new ConfigMCP.Remote({ type: "remote", url: tooMany.url }),
              directory: process.cwd(),
              timeout: { startup: 2_000, request: 2_000 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            })
            return yield* Effect.result(client.resources())
          }),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("catalog")
    } finally {
      await tooMany.stop()
    }

    const tooLarge = fixture({
      resources: true,
      resourcePage: () => ({ resources: [{ uri: "custom:large", name: "large", description: "x".repeat(1_050_000) }] }),
    })
    try {
      const compiler = await Effect.runPromise(load())
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* MCPClient.open({
              server: new ConfigMCP.Remote({ type: "remote", url: tooLarge.url }),
              directory: process.cwd(),
              timeout: { startup: 2_000, request: 2_000 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            })
            return yield* Effect.result(client.resources())
          }),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("catalog")
    } finally {
      await tooLarge.stop()
    }

    const tooManyPages = fixture({
      resources: true,
      resourcePage: (cursor) => {
        const page = cursor ? Number(cursor) + 1 : 1
        return { resources: [], nextCursor: String(page) }
      },
    })
    try {
      const compiler = await Effect.runPromise(load())
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* MCPClient.open({
              server: new ConfigMCP.Remote({ type: "remote", url: tooManyPages.url }),
              directory: process.cwd(),
              timeout: { startup: 2_000, request: 2_000 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            })
            return yield* Effect.result(client.resources())
          }),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("catalog")
      expect(tooManyPages.posts.filter((method) => method === "resources/list")).toHaveLength(128)
    } finally {
      await tooManyPages.stop()
    }
  })

  it("reads the exact custom URI and preserves text, blob, and multiple content entries", async () => {
    const uri = "custom+opaque://host/path?query=%2F#fragment"
    const expected: ResourceResult = {
      contents: [
        { uri, mimeType: "text/plain", text: "  exact text\n" },
        { uri, mimeType: "application/octet-stream", blob: "AAEC/w==" },
        { uri: "custom:second", text: "second entry" },
      ],
      _meta: { resource: "metadata" },
    }
    const server = fixture({ resources: true, readResult: expected })
    try {
      const compiler = await Effect.runPromise(load())
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
            return yield* client.read(uri)
          }),
        ),
      )

      expect(result).toEqual(expected)
      expect(server.resourceReadURIs).toEqual([uri])
      expect(server.posts.filter((method) => method === "resources/read")).toHaveLength(1)
    } finally {
      await server.stop()
    }

    const oversized = fixture({
      resources: true,
      readResult: { contents: [{ uri: "custom:oversized", text: "x".repeat(MAX_RESOURCE_BYTES + 1) }] },
    })
    try {
      const compiler = await Effect.runPromise(load())
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* MCPClient.open({
              server: new ConfigMCP.Remote({ type: "remote", url: oversized.url }),
              directory: process.cwd(),
              timeout: { startup: 5_000, request: 5_000 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            })
            return yield* Effect.result(client.read("custom:oversized"))
          }),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("budget")
    } finally {
      await oversized.stop()
    }
  })

  it("maps resource RPC auth challenges and timeouts without replay", async () => {
    const unauthorized = fixture({ resources: true, unauthorizedMethod: "resources/list" })
    try {
      const compiler = await Effect.runPromise(load())
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* MCPClient.open({
              server: new ConfigMCP.Remote({ type: "remote", url: unauthorized.url, headers: { authorization } }),
              directory: process.cwd(),
              timeout: { startup: 2_000, request: 2_000 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            })
            return yield* Effect.result(client.resources())
          }),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("authentication_required")
      expect(unauthorized.posts.filter((method) => method === "resources/list")).toHaveLength(1)
      expect(unauthorized.posts.filter((method) => method === "initialize")).toHaveLength(1)
      expect(unauthorized.authorized).toBeGreaterThan(0)
    } finally {
      await unauthorized.stop()
    }

    const timedOut = fixture({ resources: true, delayMethod: "resources/read", delayMs: 300 })
    try {
      const compiler = await Effect.runPromise(load())
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* MCPClient.open({
              server: new ConfigMCP.Remote({ type: "remote", url: timedOut.url }),
              directory: process.cwd(),
              timeout: { startup: 2_000, request: 60 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            })
            return yield* Effect.result(client.read("custom:slow"))
          }),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        expect(result.failure.kind).toBe("timeout")
        expect(result.failure.message).toContain("outcome is unknown")
      }
      expect(timedOut.posts.filter((method) => method === "resources/read")).toHaveLength(1)
    } finally {
      await timedOut.stop()
    }

    const timedOutCatalog = fixture({ resources: true, delayMethod: "resources/list", delayMs: 300 })
    try {
      const compiler = await Effect.runPromise(load())
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* MCPClient.open({
              server: new ConfigMCP.Remote({ type: "remote", url: timedOutCatalog.url }),
              directory: process.cwd(),
              timeout: { startup: 2_000, request: 60 },
              compiler,
              onClose: () => {},
              onToolsChanged: () => {},
            })
            return yield* Effect.result(client.resources())
          }),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("timeout")
      expect(timedOutCatalog.posts.filter((method) => method === "resources/list")).toHaveLength(1)
    } finally {
      await timedOutCatalog.stop()
    }
  })

  it("keeps an advertised resource method failure as a typed request error", async () => {
    const server = fixture({ resources: true, rpcErrorMethod: "resources/list" })
    try {
      const compiler = await Effect.runPromise(load())
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
            return yield* Effect.result(client.resources())
          }),
        ),
      )
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.kind).toBe("request")
      expect(server.posts.filter((method) => method === "resources/list")).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })

  it("interrupts a pending read and leaves the connection available", async () => {
    const server = fixture({ resources: true, delayMethod: "resources/read", delayMs: 500 })
    try {
      const compiler = await Effect.runPromise(load())
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
            const fiber = yield* client.read("custom:cancelled").pipe(Effect.forkChild)
            yield* Effect.promise(() => server.waitFor("resources/read"))
            yield* Fiber.interrupt(fiber)
            const interrupted = yield* Fiber.await(fiber)
            const resources = yield* client.resources()
            return { interrupted, resources }
          }),
        ),
      )

      expect(Exit.isFailure(result.interrupted)).toBe(true)
      expect(result.resources).toEqual({ supported: true, items: [] })
      expect(server.posts.filter((method) => method === "resources/read")).toHaveLength(1)
      expect(server.posts.filter((method) => method === "resources/list")).toHaveLength(1)
    } finally {
      await server.stop()
    }
  })

  it("supports resource discovery and reads over stdio", async () => {
    const compiler = await Effect.runPromise(load())
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* MCPClient.open({
            server: new ConfigMCP.Local({ type: "local", command: [process.execPath, stdioFixture] }),
            directory: process.cwd(),
            timeout: { startup: 5_000, request: 2_000 },
            compiler,
            onClose: () => {},
            onToolsChanged: () => {},
          })
          const resources = yield* client.resources()
          const templates = yield* client.templates()
          const read = yield* client.read("fixture:stdio")
          return { resources, templates, read }
        }),
      ),
    )

    expect(result.resources).toEqual({
      supported: true,
      items: [{ uri: "fixture:stdio", name: "stdio-resource" }],
    })
    expect(result.templates).toEqual({
      supported: true,
      items: [{ uriTemplate: "fixture:{name}", name: "stdio-template" }],
    })
    expect(result.read).toEqual({ contents: [{ uri: "fixture:stdio", text: "stdio resource" }] })
  })
})

function fixture(options: {
  resources: boolean
  unauthorizedMethod?: string
  rpcErrorMethod?: string
  notifyResourcesOnList?: boolean
  delayMethod?: string
  delayMs?: number
  resourcePage?: (cursor?: string) => { resources: unknown[]; nextCursor?: string }
  templatePage?: (cursor?: string) => { resourceTemplates: unknown[]; nextCursor?: string }
  readResult?: ResourceResult
}) {
  const posts: string[] = []
  const resourceReadURIs: string[] = []
  const waiters = new Map<string, Array<() => void>>()
  let gets = 0
  let authorized = 0
  let resourcesNotificationSent = false
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      if (request.method === "GET") {
        gets++
        return new Response(null, { status: 405 })
      }
      const message = (await request.json()) as RequestMessage
      posts.push(message.method)
      if (request.headers.get("authorization") === authorization) authorized++
      for (const resolve of waiters.get(message.method) ?? []) resolve()
      waiters.delete(message.method)
      if (options.unauthorizedMethod === message.method)
        return new Response("auth", { status: 401, headers: { "www-authenticate": "Bearer" } })
      if (options.rpcErrorMethod === message.method)
        return Response.json({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: "fixture method error" },
        })
      if (message.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (message.method === "initialize")
        return jsonRPC(message, {
          protocolVersion: "2025-03-26",
          capabilities: options.resources ? { resources: { listChanged: true } } : {},
          serverInfo: { name: "resource-fixture", version: "1.0.0" },
        })
      if (options.delayMethod === message.method) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      if (message.method === "resources/list") {
        const page = options.resourcePage?.(message.params?.cursor)
        const body = jsonRPCBody(message, page ?? { resources: [] })
        if (options.notifyResourcesOnList && !resourcesNotificationSent) {
          resourcesNotificationSent = true
          return Response.json([{ jsonrpc: "2.0", method: "notifications/resources/list_changed" }, body], {
            headers: { "mcp-session-id": "resource-session" },
          })
        }
        return Response.json(body, { headers: { "mcp-session-id": "resource-session" } })
      }
      if (message.method === "resources/templates/list") {
        const page = options.templatePage?.(message.params?.cursor)
        return Response.json(jsonRPCBody(message, page ?? { resourceTemplates: [] }), {
          headers: { "mcp-session-id": "resource-session" },
        })
      }
      if (message.method === "resources/read") {
        if (message.params?.uri) resourceReadURIs.push(message.params.uri)
        return Response.json(
          jsonRPCBody(message, options.readResult ?? { contents: [{ uri: message.params?.uri ?? "", text: "read" }] }),
          {
            headers: { "mcp-session-id": "resource-session" },
          },
        )
      }
      return new Response(null, { status: 202 })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    posts,
    resourceReadURIs,
    get gets() {
      return gets
    },
    get authorized() {
      return authorized
    },
    waitFor: (method: string) => {
      if (posts.includes(method)) return Promise.resolve()
      return new Promise<void>((resolve) => waiters.set(method, [...(waiters.get(method) ?? []), resolve]))
    },
    stop: () => server.stop(true),
  }
}

type RequestMessage = {
  readonly id?: number | string
  readonly method: string
  readonly params?: { readonly cursor?: string; readonly uri?: string }
}

function jsonRPCBody(message: RequestMessage, result: unknown) {
  return { jsonrpc: "2.0", id: message.id, result }
}

function jsonRPC(message: RequestMessage, result: unknown) {
  return Response.json(jsonRPCBody(message, result), { headers: { "mcp-session-id": "resource-session" } })
}
