import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import os from "node:os"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

function request(route: string, directory?: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (directory) headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, { ...init, headers }),
    HttpApiApp.context,
  )
}

function atLocation(route: string, directory: string, init: RequestInit = {}) {
  const url = new URL(route, "http://localhost")
  url.searchParams.set("location[directory]", directory)
  return request(`${url.pathname}${url.search}`, undefined, init)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("native workspace HttpApi", () => {
  test("global project and paths routes stay cold and ignore a bogus selected-location header", async () => {
    const bogus = path.join(process.cwd(), "missing-native-workspace-location")

    const projects = await request("/api/project", bogus)
    expect(projects.status).toBe(200)
    expect(await projects.json()).toEqual([])

    const paths = await request("/api/location/paths", bogus)
    expect(paths.status).toBe(200)
    expect(await paths.json()).toEqual({
      home: process.env.OPENCODE_TEST_HOME ?? os.homedir(),
      defaultDirectory: process.cwd(),
    })
  })

  test("global project listing returns persisted metadata without resolving the supplied header", async () => {
    await using tmp = await tmpdir({ git: true })

    const opened = await request("/project/current", tmp.path)
    expect(opened.status).toBe(200)
    const project = (await opened.json()) as { id: string; worktree: string; vcs?: string }

    const listed = await request("/api/project", path.join(tmp.path, "does-not-exist"))
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual([project])
    expect(project).toMatchObject({ worktree: tmp.path, vcs: "git" })
  })

  test("location resolution reports Git and non-Git project identity for the selected directory", async () => {
    await using git = await tmpdir({ git: true })
    await using plain = await tmpdir()

    const gitResponse = await atLocation("/api/location", git.path)
    expect(gitResponse.status).toBe(200)
    const gitLocation = (await gitResponse.json()) as { directory: string; project: { id: string; directory: string } }
    expect(gitLocation).toMatchObject({
      directory: git.path,
      project: { directory: git.path },
    })
    expect(gitLocation.project.id).not.toBe("global")

    const plainResponse = await atLocation("/api/location", plain.path)
    expect(plainResponse.status).toBe(200)
    expect(await plainResponse.json()).toMatchObject({
      directory: plain.path,
      project: { id: "global", directory: path.parse(plain.path).root },
    })
  })

  test("canonical filesystem list and find routes return location envelopes and fixture-relative paths", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await mkdir(path.join(dir, "nested"))
        await Bun.write(path.join(dir, "root.txt"), "root")
        await Bun.write(path.join(dir, "nested", "needle.txt"), "needle")
      },
    })

    const listed = await atLocation("/api/fs/list", tmp.path)
    expect(listed.status).toBe(200)
    expect(await listed.json()).toEqual({
      location: {
        directory: tmp.path,
        project: { id: "global", directory: path.parse(tmp.path).root },
      },
      data: [
        { path: `nested${path.sep}`, type: "directory" },
        { path: "root.txt", type: "file" },
      ],
    })

    const findURL = new URL("http://localhost/api/fs/find")
    findURL.searchParams.set("location[directory]", tmp.path)
    findURL.searchParams.set("query", "needle")
    findURL.searchParams.set("type", "file")
    const found = await request(`${findURL.pathname}${findURL.search}`)
    expect(found.status).toBe(200)
    expect(await found.json()).toEqual({
      location: {
        directory: tmp.path,
        project: { id: "global", directory: path.parse(tmp.path).root },
      },
      data: [{ path: "nested/needle.txt", type: "file" }],
    })
  })

  test("global project and location paths require server authentication", async () => {
    const handler = HttpRouter.toWebHandler(
      HttpApiApp.routes.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ OPENCODE_SERVER_PASSWORD: "secret", OPENCODE_SERVER_USERNAME: "opencode" }),
          ),
        ),
      ),
      { disableLogger: true },
    ).handler

    for (const route of ["/api/project", "/api/location/paths"]) {
      const unauthorized = await handler(
        new Request(`http://localhost${route}`, {
          headers: { "x-opencode-directory": path.join(process.cwd(), "missing-auth-location") },
        }),
        HttpApiApp.context,
      )
      expect(unauthorized.status).toBe(401)

      const authorized = await handler(
        new Request(`http://localhost${route}`, {
          headers: {
            authorization: ServerAuth.header({ username: "opencode", password: "secret" }) ?? "",
            "x-opencode-directory": path.join(process.cwd(), "missing-auth-location"),
          },
        }),
        HttpApiApp.context,
      )
      expect(authorized.status).toBe(200)
      if (route === "/api/location/paths")
        expect(await authorized.json()).toMatchObject({ defaultDirectory: process.cwd() })
      if (route === "/api/project") expect(await authorized.json()).toEqual([])
    }
  })
})
