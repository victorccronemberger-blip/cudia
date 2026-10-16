import { describe, expect, test } from "bun:test"
import type {
  AgentListOutput,
  ModelDefaultOutput,
  ModelListOutput,
  ProviderListOutput,
} from "@opencode-ai/client/promise"
import type { AgentsListOutput, ModelsListOutput, ProvidersListOutput } from "@opencode-ai/runtime-client"
import {
  directoryKey,
  normalizeAgentList,
  normalizeNativeAgentList,
  normalizeNativeProviderList,
  normalizePermissionRequest,
  normalizeProviderList,
} from "./utils"

describe("normalizeAgentList", () => {
  test("adapts current agents to the app agent shape", () => {
    const result = normalizeAgentList([
      {
        id: "build",
        name: "Build",
        mode: "primary",
        hidden: false,
        color: "primary",
        model: { id: "gpt-5", providerID: "openai", variant: "high" },
        request: { settings: { temperature: 0.2, topP: 0.9 }, headers: {}, body: {} },
        system: "Build software",
        permissions: [{ action: "read", resource: "*", effect: "allow" }],
      },
    ] as AgentListOutput["data"])

    expect(result).toEqual([
      {
        name: "build",
        description: undefined,
        mode: "primary",
        hidden: false,
        temperature: 0.2,
        topP: 0.9,
        color: "primary",
        permission: [{ permission: "read", pattern: "*", action: "allow" }],
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "high",
        prompt: "Build software",
        options: { temperature: 0.2, topP: 0.9 },
        steps: undefined,
      },
    ])
  })

  test("projects canonical agent request bodies without reading legacy settings", () => {
    const result = normalizeNativeAgentList([
      {
        id: "build",
        mode: "primary",
        hidden: false,
        model: { id: "gpt-5", providerID: "openai", variant: "high" },
        request: { headers: {}, body: { temperature: 0.2, topP: 0.9 } },
        system: "Build software",
        permissions: [{ action: "read", resource: "*", effect: "allow" }],
      },
    ] satisfies AgentsListOutput["data"])

    expect(result[0]).toMatchObject({
      name: "build",
      temperature: 0.2,
      topP: 0.9,
      permission: [{ permission: "read", pattern: "*", action: "allow" }],
      model: { providerID: "openai", modelID: "gpt-5" },
      options: { temperature: 0.2, topP: 0.9 },
    })
  })
})

describe("normalizePermissionRequest", () => {
  test("adapts the current permission request to app state", () => {
    expect(
      normalizePermissionRequest({
        id: "permission-1",
        sessionID: "session-1",
        action: "read",
        resources: ["README.md"],
        save: ["*.md"],
        metadata: { path: "README.md" },
        source: { type: "tool", messageID: "message-1", callID: "call-1" },
      }),
    ).toEqual({
      id: "permission-1",
      sessionID: "session-1",
      permission: "read",
      patterns: ["README.md"],
      always: ["*.md"],
      metadata: { path: "README.md" },
      tool: { messageID: "message-1", callID: "call-1" },
    })
  })
})

describe("normalizeProviderList", () => {
  test("groups current models into the app provider catalog", () => {
    const result = normalizeProviderList(
      [{ id: "openai", name: "OpenAI", package: "@ai-sdk/openai" }] as ProviderListOutput["data"],
      [
        {
          id: "gpt-5",
          modelID: "gpt-5",
          providerID: "openai",
          name: "GPT-5",
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          variants: [{ id: "high" }],
          time: { released: 1 },
          cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
          status: "active",
          enabled: true,
          limit: { context: 128_000, output: 8_192 },
        },
        {
          id: "gpt-old",
          modelID: "gpt-old",
          providerID: "openai",
          name: "GPT Old",
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "deprecated",
          enabled: true,
          limit: { context: 1, output: 1 },
        },
      ] as ModelListOutput["data"],
      { id: "gpt-5", providerID: "openai" } as ModelDefaultOutput["data"],
    )

    expect(result.connected).toEqual(["openai"])
    expect(result.defaultModel).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(result.default).toEqual({ openai: "gpt-5" })
    expect(result.all.get("openai")?.models["gpt-old"]).toBeUndefined()
    expect(result.all.get("openai")?.models["gpt-5"]).toMatchObject({
      id: "gpt-5",
      providerID: "openai",
      capabilities: { toolcall: true, attachment: true },
      cost: { input: 1, output: 2 },
      variants: { high: {} },
    })
  })

  test("preserves an empty current default", () => {
    expect(normalizeProviderList([] as ProviderListOutput["data"], [], null).defaultModel).toBeNull()
  })

  test("projects canonical providers, model capabilities, costs, variants, and default without settings", () => {
    const providers = [
      {
        id: "openai",
        name: "OpenAI",
        api: { type: "aisdk", package: "@ai-sdk/openai", settings: { apiKey: "provider-secret" } },
        request: { headers: {}, body: { apiKey: "provider-secret" } },
      },
    ] satisfies ProvidersListOutput["data"]
    const models = [
      {
        id: "gpt-5",
        providerID: "openai",
        name: "GPT-5",
        api: { id: "gpt-5-api", type: "aisdk", package: "@ai-sdk/openai", settings: { apiKey: "model-secret" } },
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        request: { headers: { Authorization: "secret" }, body: { apiKey: "model-secret" } },
        variants: [{ id: "high", headers: {}, body: { reasoningEffort: "high" } }],
        time: { released: 1 },
        cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
        status: "active",
        enabled: true,
        limit: { context: 128_000, output: 8_192 },
      },
    ] satisfies ModelsListOutput["data"]

    const result = normalizeNativeProviderList(providers, models, models[0])

    expect(result.connected).toEqual(["openai"])
    expect(result.defaultModel).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(result.default).toEqual({ openai: "gpt-5" })
    expect(result.all.get("openai")?.models["gpt-5"]).toMatchObject({
      api: { id: "gpt-5-api", npm: "@ai-sdk/openai" },
      capabilities: {
        temperature: false,
        reasoning: false,
        toolcall: true,
        attachment: true,
        input: { text: true, image: true },
        output: { text: true },
      },
      cost: { input: 1, output: 2 },
      variants: { high: { reasoningEffort: "high" } },
      options: {},
      headers: {},
    })
    expect(result.all.get("openai")?.options).toEqual({})
  })

  test("keeps unavailable native capabilities false and omits disabled or deprecated models", () => {
    const model = {
      id: "old",
      providerID: "openai",
      name: "Old model",
      api: { id: "old", type: "native", settings: {} },
      capabilities: { tools: false, input: ["text"], output: ["text"] },
      request: { headers: {}, body: {} },
      variants: [],
      time: { released: 1 },
      cost: [],
      status: "deprecated",
      enabled: true,
      limit: { context: 1, output: 1 },
    } satisfies ModelsListOutput["data"][number]
    const result = normalizeNativeProviderList(
      [{ id: "openai", name: "OpenAI", api: { type: "native", settings: {} }, request: { headers: {}, body: {} } }],
      [model],
    )

    expect(result.all.get("openai")?.models.old).toBeUndefined()
    expect(result.defaultModel).toBeNull()
  })

  test("leaves an empty release date for finite timestamps outside the legacy date format", () => {
    const provider = {
      id: "native",
      name: "Native",
      api: { type: "native", settings: {} },
      request: { headers: {}, body: {} },
    } satisfies ProvidersListOutput["data"][number]
    const baseModel = {
      id: "model",
      providerID: "native",
      name: "Model",
      api: { id: "model", type: "native", settings: {} },
      capabilities: { tools: false, input: ["text"], output: ["text"] },
      request: { headers: {}, body: {} },
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: 1, output: 1 },
    } satisfies ModelsListOutput["data"][number]

    const releaseDate = (released: number) =>
      normalizeNativeProviderList([provider], [{ ...baseModel, time: { released } }]).all.get("native")?.models.model
        .release_date

    expect(releaseDate(-8_640_000_000_000_001)).toBe("")
    expect(releaseDate(8_640_000_000_000_001)).toBe("")
    expect(releaseDate(-8_640_000_000_000_000)).toBe("")
    expect(releaseDate(8_640_000_000_000_000)).toBe("")
    expect(releaseDate(Date.UTC(2025, 0, 2))).toBe("2025-01-02")
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\opencode"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/Repos/sst/opencode"))).toBe("C:/Repos/sst/opencode")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/opencode/"))).toBe("C:/Repos/sst/opencode")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})
