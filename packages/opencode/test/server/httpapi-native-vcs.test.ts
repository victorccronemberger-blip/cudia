import { afterEach, describe, expect, test } from "bun:test"
import { $ } from "bun"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { mkdir } from "node:fs/promises"
import path from "node:path"
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

function expectLocation(body: unknown, directory: string) {
  expect(body).toMatchObject({ location: { directory } })
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("native VCS HttpApi", () => {
  test("working status and diff stay within a selected subdirectory and preserve literal filenames", async () => {
    await using repo = await tmpdir({
      git: true,
      init: async (dir) => {
        await mkdir(path.join(dir, "subdir"))
        await Bun.write(path.join(dir, "subdir", "staged.txt"), "staged original\n")
        await Bun.write(path.join(dir, "subdir", "working.txt"), "working original\n")
        await Bun.write(path.join(dir, "sibling.txt"), "sibling original\n")
        await $`git add -- subdir/staged.txt subdir/working.txt sibling.txt`.cwd(dir).quiet()
        await $`git commit -m "add fixture files"`.cwd(dir).quiet()
      },
    })
    const selected = path.join(repo.path, "subdir")
    const literal = "new % # café.txt"
    await Bun.write(path.join(selected, "staged.txt"), "staged content\n")
    await $`git add -- subdir/staged.txt`.cwd(repo.path).quiet()
    await Bun.write(path.join(selected, "working.txt"), "working content\n")
    await Bun.write(path.join(selected, literal), "literal file bytes\n")
    await Bun.write(path.join(repo.path, "sibling.txt"), "sibling changed\n")

    const statusResponse = await atLocation("/api/vcs/status", selected)
    expect(statusResponse.status).toBe(200)
    const statusBody = await statusResponse.json()
    expectLocation(statusBody, selected)
    expect(statusBody.data).toEqual([
      expect.objectContaining({ file: literal, status: "added" }),
      expect.objectContaining({ file: "staged.txt", status: "modified" }),
      expect.objectContaining({ file: "working.txt", status: "modified" }),
    ])
    expect(statusBody.data.some((item: { file: string }) => item.file.includes("sibling"))).toBe(false)

    const diffResponse = await atLocation("/api/vcs/diff?mode=working&context=1", selected)
    expect(diffResponse.status).toBe(200)
    const diffBody = await diffResponse.json()
    expectLocation(diffBody, selected)
    expect(diffBody.data.map((item: { file: string }) => item.file)).toEqual([literal, "staged.txt", "working.txt"])
    expect(diffBody.data.find((item: { file: string }) => item.file === "staged.txt").patch).toContain("staged content")
    expect(diffBody.data.find((item: { file: string }) => item.file === "working.txt").patch).toContain(
      "working content",
    )

    const readUrl = `/api/fs/read/${encodeURIComponent(literal)}`
    const readResponse = await atLocation(readUrl, selected)
    expect(readResponse.status).toBe(200)
    expect(await readResponse.text()).toBe("literal file bytes\n")
  })

  test("find observes files created after the first request", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "first-needle.txt"), "first")
      },
    })

    const initial = await atLocation("/api/fs/find?query=needle&type=file", tmp.path)
    expect(initial.status).toBe(200)
    const initialBody = await initial.json()
    expectLocation(initialBody, tmp.path)
    expect(initialBody.data).toEqual([{ path: "first-needle.txt", type: "file" }])

    await Bun.write(path.join(tmp.path, "second-needle.txt"), "second")
    const fresh = await atLocation("/api/fs/find?query=needle&type=file", tmp.path)
    expect(fresh.status).toBe(200)
    const freshBody = await fresh.json()
    expectLocation(freshBody, tmp.path)
    expect(freshBody.data).toEqual([
      { path: "first-needle.txt", type: "file" },
      { path: "second-needle.txt", type: "file" },
    ])
  })

  test("non-Git locations return empty VCS data and invalid diff inputs are rejected", async () => {
    await using tmp = await tmpdir()

    const info = await atLocation("/api/vcs", tmp.path)
    expect(info.status).toBe(200)
    const infoBody = await info.json()
    expectLocation(infoBody, tmp.path)
    expect(infoBody.data).toEqual({})

    const status = await atLocation("/api/vcs/status", tmp.path)
    expect(status.status).toBe(200)
    const statusBody = await status.json()
    expectLocation(statusBody, tmp.path)
    expect(statusBody.data).toEqual([])

    const diff = await atLocation("/api/vcs/diff?mode=working", tmp.path)
    expect(diff.status).toBe(200)
    const diffBody = await diff.json()
    expectLocation(diffBody, tmp.path)
    expect(diffBody.data).toEqual([])

    expect((await atLocation("/api/vcs/diff?mode=bogus", tmp.path)).status).toBe(400)
    expect((await atLocation("/api/vcs/diff?mode=working&context=-1", tmp.path)).status).toBe(400)
  })

  test("branch diff is empty on the default branch and includes divergent committed content", async () => {
    await using repo = await tmpdir({ git: true })
    await $`git branch -M main`.cwd(repo.path).quiet()
    await $`git config init.defaultBranch main`.cwd(repo.path).quiet()
    await Bun.write(path.join(repo.path, "history.txt"), "base content\n")
    await $`git add -- history.txt`.cwd(repo.path).quiet()
    await $`git commit -m "base content"`.cwd(repo.path).quiet()

    const onDefault = await atLocation("/api/vcs/diff?mode=branch&context=1", repo.path)
    expect(onDefault.status).toBe(200)
    const defaultBody = await onDefault.json()
    expectLocation(defaultBody, repo.path)
    expect(defaultBody.data).toEqual([])

    await $`git checkout -b feature`.cwd(repo.path).quiet()
    await Bun.write(path.join(repo.path, "history.txt"), "feature content\n")
    await $`git add -- history.txt`.cwd(repo.path).quiet()
    await $`git commit -m "feature content"`.cwd(repo.path).quiet()

    const divergent = await atLocation("/api/vcs/diff?mode=branch&context=1", repo.path)
    expect(divergent.status).toBe(200)
    const body = await divergent.json()
    expectLocation(body, repo.path)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({ file: "history.txt", status: "modified" })
    expect(body.data[0].patch).toContain("feature content")
    expect(body.data[0].patch).toContain("base content")
  })

  test("VCS routes authenticate before resolving a bogus location", async () => {
    await using tmp = await tmpdir({ git: true })
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

    for (const route of ["/api/vcs", "/api/vcs/status", "/api/vcs/diff?mode=working"]) {
      const bogus = path.join(process.cwd(), "missing-vcs-auth-location")
      const url = new URL(route, "http://localhost")
      url.searchParams.set("location[directory]", bogus)
      const unauthorized = await handler(
        new Request(url, { headers: { "x-opencode-directory": bogus } }),
        HttpApiApp.context,
      )
      expect(unauthorized.status).toBe(401)

      const authorizedUrl = new URL(route, "http://localhost")
      authorizedUrl.searchParams.set("location[directory]", tmp.path)
      const authorized = await handler(
        new Request(authorizedUrl, {
          headers: {
            authorization: ServerAuth.header({ username: "opencode", password: "secret" }) ?? "",
          },
        }),
        HttpApiApp.context,
      )
      expect(authorized.status).toBe(200)
    }
  })
})
