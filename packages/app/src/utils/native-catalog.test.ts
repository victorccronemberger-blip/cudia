import { expect, test } from "bun:test"
import { createNativeCatalogClient } from "./native-catalog"

test("uses canonical catalog routes, directory scope, auth, and the supplied fetch", async () => {
  const calls: { method: string; pathname: string; search: string; authorization: string | null }[] = []
  const fetcher = async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({
      method: init?.method ?? "GET",
      pathname: url.pathname,
      search: url.search,
      authorization: new Headers(init?.headers).get("authorization"),
    })
    return Response.json({
      location: { directory: "/project", project: { id: "project", directory: "/project" } },
      data: url.pathname === "/api/model/default" ? null : [],
    })
  }
  const client = createNativeCatalogClient({
    server: { url: "http://localhost:4096", username: "operator", password: "secret" },
    fetch: fetcher as typeof globalThis.fetch,
  })

  await client.providers.list({ location: { directory: "/project" } })
  await client.models.list({ location: { directory: "/project" } })
  await client.models.default({ location: { directory: "/project" } })
  await client.agents.list({ location: { directory: "/project" } })

  expect(calls.map((call) => call.pathname)).toEqual([
    "/api/provider",
    "/api/model",
    "/api/model/default",
    "/api/agent",
  ])
  expect(calls.every((call) => call.method === "GET")).toBe(true)
  expect(calls.every((call) => call.search.includes("location%5Bdirectory%5D=%2Fproject"))).toBe(true)
  expect(calls.every((call) => call.authorization === `Basic ${btoa("operator:secret")}`)).toBe(true)
})
