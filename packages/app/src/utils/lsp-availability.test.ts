import { describe, expect, mock, test } from "bun:test"
import type { LspStatus, OpencodeClient } from "@opencode-ai/sdk/v2/client"
import { loadLspQuery } from "@/context/server-sync"
import { ServerScope } from "@/utils/server-scope"
import { createNativeLspClient } from "./native-lsp"
import type { LspStatusOutput } from "@opencode-ai/runtime-client"

const location = { directory: "/project", project: { id: "project", directory: "/project" } }

describe("loadLspQuery protocol availability", () => {
  test("fetches native V2 status for the current Location without calling the legacy SDK", async () => {
    const status = mock(async () => ({
      data: [{ id: "typescript", name: "TypeScript", root: "/project", status: "connected" }],
    }))
    const sdk = { lsp: { status } } as unknown as OpencodeClient
    const statuses: LspStatusOutput["data"] = [
      { id: "typescript", name: "typescript", root: "/project", status: "not_started" },
    ]
    const native = { status: mock(async () => ({ location, data: statuses })) }
    const options = loadLspQuery(ServerScope.local, "/project", sdk, Promise.resolve("v2"), () => "v2", native)

    expect(options.enabled).toBe(true)
    if (typeof options.queryFn !== "function") throw new Error("LSP query function required")
    await expect(options.queryFn({} as never)).resolves.toEqual(statuses)
    expect(status).not.toHaveBeenCalled()
    expect(native.status).toHaveBeenCalledTimes(1)
    expect(native.status).toHaveBeenCalledWith({ location: { directory: "/project" } })
  })

  test("continues to fetch legacy SDK statuses on V1", async () => {
    const statuses: LspStatus[] = [{ id: "typescript", name: "TypeScript", root: "/project", status: "connected" }]
    const status = mock(async () => ({ data: statuses }))
    const sdk = { lsp: { status } } as unknown as OpencodeClient
    const native = { status: mock(async () => ({ location, data: [] })) }
    const options = loadLspQuery(ServerScope.local, "/project", sdk, Promise.resolve("v1"), () => "v1", native)

    expect(options.enabled).toBe(true)
    if (typeof options.queryFn !== "function") throw new Error("LSP query function required")
    await expect(options.queryFn({} as never)).resolves.toEqual(statuses)
    expect(status).toHaveBeenCalledTimes(1)
    expect(native.status).not.toHaveBeenCalled()
  })

  test("waits for protocol detection before enabling status fetches", () => {
    const legacy = mock(async () => ({ data: [] }))
    const native = { status: mock(async () => ({ location, data: [] })) }
    const sdk = { lsp: { status: legacy } } as unknown as OpencodeClient
    const options = loadLspQuery(ServerScope.local, "/project", sdk, Promise.resolve("v2"), () => undefined, native)
    expect(options.enabled).toBe(false)
    expect(legacy).not.toHaveBeenCalled()
    expect(native.status).not.toHaveBeenCalled()
  })

  test("preserves native status failures without falling back to legacy or an empty list", async () => {
    const legacy = mock(async () => ({ data: [] }))
    const native = {
      status: mock(async () => {
        throw new Error("status unavailable")
      }),
    }
    const sdk = { lsp: { status: legacy } } as unknown as OpencodeClient
    const options = loadLspQuery(ServerScope.local, "/project", sdk, Promise.resolve("v2"), () => "v2", native)
    if (typeof options.queryFn !== "function") throw new Error("LSP query function required")
    await expect(options.queryFn({} as never)).rejects.toThrow("status unavailable")
    expect(legacy).not.toHaveBeenCalled()
  })

  test("uses only the authenticated native metadata GET route and preserves directory scope", async () => {
    const calls: { method: string; path: string; directory: string | null; authorization: string | null }[] = []
    const client = createNativeLspClient({
      server: { url: "http://localhost:4096", username: "operator", password: "secret" },
      fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input))
        calls.push({
          method: init?.method ?? "GET",
          path: url.pathname,
          directory: url.searchParams.get("location[directory]"),
          authorization: new Headers(init?.headers).get("authorization"),
        })
        return Response.json({
          location,
          data: [{ id: "typescript", name: "typescript", root: "/project", status: "not_started" }],
        })
      }) as typeof globalThis.fetch,
    })
    expect(calls).toHaveLength(0)
    expect((await client.status({ location: { directory: "/project" } })).data[0]?.status).toBe("not_started")
    expect(calls).toEqual([
      { method: "GET", path: "/api/lsp", directory: "/project", authorization: `Basic ${btoa("operator:secret")}` },
    ])
  })
})
