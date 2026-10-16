import { afterEach, describe, expect, test } from "bun:test"
import { ConfigProvider, Layer } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { ServerAuth } from "../../src/server/auth"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { resetDatabase } from "../fixture/db"

const path = "/api/model/default"

function request(route: string, directory: string | undefined, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (directory) headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, { ...init, headers }),
    HttpApiApp.context,
  )
}

function requestAtLocation(route: string, directory: string, init: RequestInit = {}) {
  const query = new URLSearchParams({ "location[directory]": directory })
  return request(`${route}?${query}`, undefined, init)
}

function modelConfig(model: string, models: Record<string, object>) {
  return {
    formatter: false,
    lsp: false,
    model: `test/${model}`,
    experimental: {
      policies: [{ effect: "deny" as const, action: "provider.use" as const, resource: "opencode" }],
    },
    providers: {
      test: {
        request: { body: { apiKey: "test-key" } },
        models,
      },
    },
  }
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("model default HttpApi", () => {
  test("returns the configured default and keeps catalog selection scoped to each location", async () => {
    await using first = await tmpdir({
      git: true,
      config: modelConfig("configured", { newest: { name: "Newest model" }, configured: { name: "Configured model" } }),
    })
    await using second = await tmpdir({
      git: true,
      config: modelConfig("second", { second: { name: "Second location model" } }),
    })

    const firstDefault = await requestAtLocation(path, first.path)
    expect(firstDefault.status).toBe(200)
    expect(await firstDefault.json()).toMatchObject({
      location: { directory: first.path },
      data: { id: "configured", providerID: "test", name: "Configured model" },
    })

    const firstList = await requestAtLocation("/api/model", first.path)
    expect(firstList.status).toBe(200)
    const models = ((await firstList.json()) as { data: Array<{ id: string; name: string }> }).data
    expect(models.map((model) => model.id)).toContain("newest")
    expect(models[0]?.id).toBe("newest")

    const secondDefault = await requestAtLocation(path, second.path)
    expect(secondDefault.status).toBe(200)
    expect(await secondDefault.json()).toMatchObject({
      location: { directory: second.path },
      data: { id: "second", providerID: "test", name: "Second location model" },
    })

    const firstAgain = await requestAtLocation(path, first.path)
    expect(await firstAgain.json()).toMatchObject({ data: { id: "configured" } })
  })

  test("falls back when the configured model is disabled", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: modelConfig("disabled", { fallback: { name: "Available fallback" }, disabled: { disabled: true } }),
    })

    const response = await requestAtLocation(path, tmp.path)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      data: { id: "fallback", providerID: "test", name: "Available fallback" },
    })
  })

  test("returns null when the location has no available models", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        formatter: false,
        lsp: false,
        experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "opencode" }] },
      },
    })

    const response = await requestAtLocation(path, tmp.path)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ location: { directory: tmp.path }, data: null })
  })

  test("requires server authentication", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        formatter: false,
        lsp: false,
        experimental: { policies: [{ effect: "deny", action: "provider.use", resource: "opencode" }] },
      },
    })
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
    const query = new URLSearchParams({ "location[directory]": tmp.path })

    const unauthorized = await handler(new Request(`http://localhost${path}?${query}`), HttpApiApp.context)
    expect(unauthorized.status).toBe(401)

    const authorized = await handler(
      new Request(`http://localhost${path}?${query}`, {
        headers: { authorization: ServerAuth.header({ username: "opencode", password: "secret" }) ?? "" },
      }),
      HttpApiApp.context,
    )
    expect(authorized.status).toBe(200)
    expect(await authorized.json()).toMatchObject({ data: null })
  })
})
