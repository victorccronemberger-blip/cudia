import { describe, expect, test } from "bun:test"
import {
  createNativeMcpClient,
  isNativeMcpAuthenticationRequired,
  mutateNativeMcp,
  presentNativeMcp,
} from "./native-mcp"

describe("native MCP client", () => {
  test("recognizes the generated canonical OAuth challenge error", () => {
    expect(
      isNativeMcpAuthenticationRequired({
        _tag: "InvalidRequestError",
        message: "OAuth is required",
        kind: "mcp_authentication_required",
      }),
    ).toBe(true)
    expect(
      isNativeMcpAuthenticationRequired({
        _tag: "InvalidRequestError",
        message: "Invalid request",
        kind: "invalid_request",
      }),
    ).toBe(false)
  })

  test("uses canonical MCP and integration routes with the server transport", async () => {
    const calls: { method: string; pathname: string; search: string; authorization: string | null; body?: unknown }[] = []
    const fetcher = async (input: URL | RequestInfo, init?: RequestInit) => {
      const url = new URL(String(input))
      const headers = new Headers(init?.headers)
      calls.push({
        method: init?.method ?? "GET",
        pathname: url.pathname,
        search: url.search,
        authorization: headers.get("authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })
      if (url.pathname === "/api/mcp") {
        return Response.json({
          location: { directory: "/project", project: { id: "project", directory: "/project" } },
          data: [
            {
              name: "docs",
              status: "authentication_required",
              toolCount: 2,
              exposureCount: 1,
              authentication: { integrationID: "docs", methodID: "oauth" },
            },
          ],
        })
      }
      if (url.pathname === "/api/integration/docs/connect/oauth") {
        return Response.json({
          location: { directory: "/project", project: { id: "project", directory: "/project" } },
          data: {
            attemptID: "attempt-1",
            url: "https://identity.example/authorize",
            instructions: "Continue in your browser",
            mode: "auto",
            time: { created: 1, expires: 2 },
          },
        })
      }
      if (url.pathname === "/api/integration/attempt/attempt-1" && init?.method !== "DELETE") {
        return Response.json({
          location: { directory: "/project", project: { id: "project", directory: "/project" } },
          data: { status: "complete", time: { created: 1, expires: 2 } },
        })
      }
      return new Response(null, { status: 204 })
    }
    const client = createNativeMcpClient({
      server: { url: "http://localhost:4096", username: "operator", password: "secret" },
      fetch: fetcher as typeof globalThis.fetch,
    })

    const listed = await client.mcp.list({ location: { directory: "/project" } })
    await client.mcp.connect({ server: "docs", location: { directory: "/project" } })
    await client.mcp.disconnect({ server: "docs", location: { directory: "/project" } })
    await client.integrations.connectOauth({
      integrationID: "docs",
      methodID: "oauth",
      inputs: {},
      location: { directory: "/project" },
    })
    await client.integrations.attemptStatus({ attemptID: "attempt-1", location: { directory: "/project" } })
    await client.integrations.attemptComplete({ attemptID: "attempt-1", location: { directory: "/project" } })
    await client.integrations.attemptCancel({ attemptID: "attempt-1", location: { directory: "/project" } })

    expect(listed.data[0]).toMatchObject({
      name: "docs",
      status: "authentication_required",
      authentication: { integrationID: "docs", methodID: "oauth" },
    })
    expect(calls.map(({ method, pathname }) => [method, pathname])).toEqual([
      ["GET", "/api/mcp"],
      ["POST", "/api/mcp/docs/connect"],
      ["POST", "/api/mcp/docs/disconnect"],
      ["POST", "/api/integration/docs/connect/oauth"],
      ["GET", "/api/integration/attempt/attempt-1"],
      ["POST", "/api/integration/attempt/attempt-1/complete"],
      ["DELETE", "/api/integration/attempt/attempt-1"],
    ])
    expect(calls.every((call) => call.authorization === `Basic ${btoa("operator:secret")}`)).toBe(true)
    expect(calls.every((call) => call.search.includes("location%5Bdirectory%5D=%2Fproject"))).toBe(true)
    expect(calls[3].body).toEqual({ methodID: "oauth", inputs: {} })
    expect(calls.some((call) => call.pathname.startsWith("/experimental/mcp/"))).toBe(false)
  })

  test("maps native lifecycle states to localized legacy presentation states", () => {
    const common = { name: "docs", toolCount: 3, exposureCount: 2 }
    expect(presentNativeMcp({ ...common, status: "authentication_required" })).toMatchObject({
      status: "needs_auth",
      nativeStatus: "authentication_required",
      toolCount: 3,
      exposureCount: 2,
    })
    expect(presentNativeMcp({ ...common, status: "disconnected" })).toMatchObject({
      status: "disabled",
      nativeStatus: "disconnected",
    })
    expect(presentNativeMcp({ ...common, status: "connecting" })).toMatchObject({
      status: "pending",
      nativeStatus: "connecting",
    })
  })

  test("refreshes an OAuth challenge after failed connect so the next action can authenticate", async () => {
    let status: "disconnected" | "authentication_required" = "disconnected"
    const paths: string[] = []
    const client = createNativeMcpClient({
      server: { url: "http://localhost:4096" },
      fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input))
        paths.push(`${init?.method ?? "GET"} ${url.pathname}`)
        if (url.pathname === "/api/mcp" && init?.method !== "POST") {
          return Response.json({
            location: { directory: "/project", project: { id: "project", directory: "/project" } },
            data: [
              {
                name: "docs",
                status,
                toolCount: 0,
                exposureCount: 0,
                authentication: { integrationID: "docs", methodID: "oauth" },
              },
            ],
          })
        }
        if (url.pathname === "/api/mcp/docs/connect") {
          status = "authentication_required"
          return Response.json({ message: "OAuth required" }, { status: 400 })
        }
        if (url.pathname === "/api/integration/docs/connect/oauth") {
          return Response.json({
            location: { directory: "/project", project: { id: "project", directory: "/project" } },
            data: {
              attemptID: "attempt-2",
              url: "https://identity.example/authorize",
              instructions: "Continue in your browser",
              mode: "auto",
              time: { created: 1, expires: 2 },
            },
          })
        }
        return new Response(null, { status: 204 })
      }) as typeof globalThis.fetch,
    })
    let current = presentNativeMcp((await client.mcp.list({ location: { directory: "/project" } })).data[0])

    await mutateNativeMcp({
      client,
      server: "docs",
      directory: "/project",
      action: "connect",
      refresh: async () => {
        current = presentNativeMcp((await client.mcp.list({ location: { directory: "/project" } })).data[0])
      },
    }).catch(() => undefined)
    const attempt = await client.integrations.connectOauth({
      integrationID: current.authentication!.integrationID,
      methodID: current.authentication!.methodID,
      inputs: {},
      location: { directory: "/project" },
    })

    expect(current).toMatchObject({ status: "needs_auth", nativeStatus: "authentication_required" })
    expect(attempt.data.attemptID).toBe("attempt-2")
    expect(paths).toEqual([
      "GET /api/mcp",
      "POST /api/mcp/docs/connect",
      "GET /api/mcp",
      "POST /api/integration/docs/connect/oauth",
    ])
    expect(paths.some((path) => path.includes("/auth"))).toBe(false)
  })
})
