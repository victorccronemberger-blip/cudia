import { describe, expect, test } from "bun:test"
import { createNativeWorkspaceClient } from "./native-workspace"

describe("native workspace client", () => {
  test("uses authenticated canonical project, location, and filesystem routes", async () => {
    const calls: { pathname: string; search: URLSearchParams; authorization: string | null }[] = []
    const client = createNativeWorkspaceClient({
      server: { url: "http://localhost:4096", username: "operator", password: "secret" },
      fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = new URL(String(input))
        calls.push({
          pathname: url.pathname,
          search: url.searchParams,
          authorization: new Headers(init?.headers).get("authorization"),
        })
        if (url.pathname === "/api/project")
          return Response.json([{ id: "project", worktree: "/repo", time: { created: 1, updated: 2 }, sandboxes: [] }])
        if (url.pathname === "/api/location/paths")
          return Response.json({ home: "/home/operator", defaultDirectory: "/repo/subdir" })
        if (url.pathname === "/api/location")
          return Response.json({
            directory: "/repo/subdir",
            project: { id: "project", directory: "/repo" },
          })
        if (url.pathname === "/api/vcs")
          return Response.json({
            location: { directory: "/repo/subdir", project: { id: "project", directory: "/repo" } },
            data: { branch: "feature", defaultBranch: "main" },
          })
        if (url.pathname === "/api/fs/list")
          return Response.json({
            location: { directory: "/repo/subdir", project: { id: "project", directory: "/repo" } },
            data: [{ path: "child/", type: "directory" }],
          })
        return Response.json({
          location: { directory: "/repo/subdir", project: { id: "project", directory: "/repo" } },
          data: [{ path: "child/", type: "directory" }],
        })
      }) as typeof globalThis.fetch,
    })

    expect((await client.projects.list())[0]?.id).toBe("project")
    expect((await client.locationPaths.get()).defaultDirectory).toBe("/repo/subdir")
    expect((await client.location.get({ location: { directory: "/repo/subdir" } })).project.directory).toBe("/repo")
    expect((await client.vcs.get({ location: { directory: "/repo/subdir" } })).data).toEqual({
      branch: "feature",
      defaultBranch: "main",
    })
    expect((await client.files.list({ location: { directory: "/repo/subdir" }, path: "." })).data).toHaveLength(1)
    expect(
      (await client.files.find({ location: { directory: "/repo/subdir" }, query: "child", type: "directory" })).data,
    ).toHaveLength(1)

    expect(calls.map((call) => call.pathname)).toEqual([
      "/api/project",
      "/api/location/paths",
      "/api/location",
      "/api/vcs",
      "/api/fs/list",
      "/api/fs/find",
    ])
    expect(calls.every((call) => call.authorization === `Basic ${btoa("operator:secret")}`)).toBe(true)
    expect(calls[2]?.search.get("location[directory]")).toBe("/repo/subdir")
    expect(calls[3]?.search.get("location[directory]")).toBe("/repo/subdir")
    expect(calls[4]?.search.get("location[directory]")).toBe("/repo/subdir")
    expect(calls[4]?.search.get("path")).toBe(".")
    expect(calls[5]?.search.get("query")).toBe("child")
  })
})
