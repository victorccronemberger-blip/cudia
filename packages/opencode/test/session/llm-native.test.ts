import { describe, expect, test } from "bun:test"
import { LLMEvent, ToolFailure } from "@opencode-ai/llm"
import { LLMClient, RequestExecutor, WebSocketExecutor, type LLMClientShape } from "@opencode-ai/llm/route"
import { jsonSchema, tool, type ModelMessage, type Tool } from "ai"
import { Effect, Fiber, Layer, Stream } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { LLMNative } from "@/session/llm/native-request"
import { LLMNativeRuntime } from "@/session/llm/native-runtime"
import type { Provider } from "@/provider/provider"

import { OAUTH_DUMMY_KEY } from "@/auth"
import { testEffect } from "../lib/effect"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"

const baseModel: Provider.Model = {
  id: ModelV2.ID.make("gpt-5-mini"),
  providerID: ProviderV2.ID.make("openai"),
  api: {
    id: "gpt-5-mini",
    url: "https://api.openai.com/v1",
    npm: "@ai-sdk/openai",
  },
  name: "GPT-5 Mini",
  capabilities: {
    temperature: true,
    reasoning: true,
    attachment: true,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: true,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 128_000,
    input: 128_000,
    output: 32_000,
  },
  status: "active",
  options: {},
  headers: {
    "x-model": "model-header",
  },
  release_date: "2026-01-01",
}

const providerInfo: Provider.Info = {
  id: ProviderV2.ID.make("openai"),
  name: "OpenAI",
  source: "config",
  env: ["OPENAI_API_KEY"],
  options: { apiKey: "test-openai-key" },
  models: {},
}

const it = testEffect(
  LLMClient.layer.pipe(
    Layer.provide(
      Layer.mergeAll(RequestExecutor.layer.pipe(Layer.provide(FetchHttpClient.layer)), WebSocketExecutor.layer),
    ),
  ),
)

function responsesStream(chunks: unknown[]) {
  return new Response(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}`).join("\n\n") + "\n\n", {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  })
}

type NativeRequestInput = Parameters<typeof LLMNative.request>[0]

const sessionText = (text: string) => ({ type: "text" as const, text })

const sessionOpenAIReasoning = (
  text: string,
  options: {
    readonly storedAs: "providerMetadata" | "providerOptions"
    readonly itemId: string
    readonly encryptedContent: string | null
  },
) => {
  const metadata = {
    openai: { itemId: options.itemId, reasoningEncryptedContent: options.encryptedContent },
  }
  if (options.storedAs === "providerMetadata")
    return Object.assign({ type: "reasoning" as const, text }, { providerMetadata: metadata })
  return Object.assign({ type: "reasoning" as const, text }, { providerOptions: metadata })
}

type SessionAssistantPart = ReturnType<typeof sessionText> | ReturnType<typeof sessionOpenAIReasoning>

const storedSession = {
  user: (content: string): ModelMessage => ({ role: "user", content }),
  assistant: (content: SessionAssistantPart[]): ModelMessage => ({ role: "assistant", content }),
  text: sessionText,
  openaiReasoning: sessionOpenAIReasoning,
}

const openAIResponses = {
  user: (text: string) => ({ role: "user", content: [{ type: "input_text", text }] }),
  assistant: (text: string) => ({ role: "assistant", content: [{ type: "output_text", text }] }),
  openaiReasoning: (text: string, encryptedContent: string) => ({
    type: "reasoning",
    encrypted_content: encryptedContent,
    summary: [{ type: "summary_text", text }],
  }),
}

const prepareNativeRequest = (input: NativeRequestInput) => LLMClient.prepare(LLMNative.request(input))

const nativeToolResult = (output: unknown) => {
  const request = LLMNative.request({
    model: baseModel,
    messages: [
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-image", toolName: "image_fixture", output }],
      } as unknown as ModelMessage,
    ],
  })
  const message = request.messages.find((item) => item.role === "tool")
  if (!message) throw new Error("Expected native tool message")
  const result = message.content.find((part) => part.type === "tool-result")
  if (!result) throw new Error("Expected native tool result")
  return result.result
}

const toolHistory = (output: unknown): ModelMessage[] =>
  [
    {
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call-image", toolName: "image_fixture", output }],
    },
  ] as unknown as ModelMessage[]

const expectOpenAIResponsesRequest = (input: {
  readonly history: NativeRequestInput["messages"]
  readonly providerOptions?: NativeRequestInput["providerOptions"]
  readonly maxOutputTokens?: NativeRequestInput["maxOutputTokens"]
  readonly headers?: NativeRequestInput["headers"]
  readonly expectedBody: unknown
}) =>
  Effect.gen(function* () {
    expect(
      yield* prepareNativeRequest({
        model: baseModel,
        apiKey: "test-openai-key",
        messages: input.history,
        providerOptions: input.providerOptions,
        maxOutputTokens: input.maxOutputTokens,
        headers: input.headers,
      }),
    ).toMatchObject({
      route: "openai-responses",
      protocol: "openai-responses",
      body: input.expectedBody,
    })
  })

describe("session.llm-native.request", () => {
  test("normalizes legacy text and image tool output into typed file content", () => {
    const result = nativeToolResult({
      type: "content",
      value: [
        { type: "text", text: "first" },
        { type: "media", mediaType: "image/png", data: "iVBORw0KGgo=" },
      ],
    })

    expect(result).toEqual({
      type: "content",
      value: [
        { type: "text", text: "first" },
        { type: "file", uri: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" },
      ],
    })
  })

  test("normalizes modern image-data and file-data while preserving order and data URLs", () => {
    const result = nativeToolResult({
      type: "content",
      value: [
        { type: "text", text: "before" },
        { type: "image-data", mediaType: "image/jpeg", data: "data:image/jpeg;base64,/9j/2Q==" },
        { type: "file-data", mediaType: "image/webp", data: "Ag==", filename: "modern.webp" },
        { type: "text", text: "after" },
      ],
    })

    expect(result).toEqual({
      type: "content",
      value: [
        { type: "text", text: "before" },
        { type: "file", uri: "data:image/jpeg;base64,/9j/2Q==", mime: "image/jpeg" },
        { type: "file", uri: "data:image/webp;base64,Ag==", mime: "image/webp", name: "modern.webp" },
        { type: "text", text: "after" },
      ],
    })
  })

  test("normalizes GIF image data and legacy embedded data URLs", () => {
    expect(
      nativeToolResult({
        type: "content",
        value: [
          { type: "media", mediaType: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" },
          { type: "media", mediaType: "image/png", data: "data:image/png;base64,AA==" },
        ],
      }),
    ).toEqual({
      type: "content",
      value: [
        {
          type: "file",
          uri: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
          mime: "image/gif",
        },
        { type: "file", uri: "data:image/png;base64,AA==", mime: "image/png" },
      ],
    })
  })

  test("falls back to the entire original JSON content for unsupported or invalid items", () => {
    const validSibling = { type: "media", mediaType: "image/png", data: "AA==" }
    const unsupported: unknown[][] = [
      [validSibling, { type: "unknown-data", data: "AA==", mediaType: "image/png" }],
      [validSibling, { type: "image-data", data: "AA==", mediaType: "image/png", providerOptions: {} }],
      [validSibling, { type: "file-data", data: "AA==", mediaType: "image/png", internal: "extra" }],
      [validSibling, { type: "media", data: "AA==", mediaType: "image/png", filename: "legacy.png" }],
      [validSibling, { type: "file-data", data: "AA==", mediaType: "application/pdf", filename: "doc.pdf" }],
      [validSibling, { type: "file-data", url: "https://example.test/image.png", mediaType: "image/png" }],
      [validSibling, { type: "file-data", fileId: "file_123", mediaType: "image/png" }],
      [validSibling, { type: "image-data", data: "data:image/jpeg;base64,AA==", mediaType: "image/png" }],
      [validSibling, { type: "image-data", data: "!!!!", mediaType: "image/png" }],
      [validSibling, { type: "image-data", data: "AB==", mediaType: "image/png" }],
    ]

    for (const value of unsupported) {
      const original = { type: "content", value }
      expect(nativeToolResult(original)).toEqual({ type: "json", value })
    }

    expect(nativeToolResult({ type: "content", value: [] })).toEqual({ type: "json", value: [] })
  })

  it.effect("sends recognized tool images as native OpenAI and Anthropic image blocks", () =>
    Effect.gen(function* () {
      const history = toolHistory({
        type: "content",
        value: [
          { type: "text", text: "inspect this" },
          { type: "image-data", data: "AA==", mediaType: "image/png" },
        ],
      })
      const openAI = yield* prepareNativeRequest({ model: baseModel, apiKey: "test-openai-key", messages: history })
      expect(openAI).toMatchObject({
        protocol: "openai-responses",
        body: {
          input: [
            {
              type: "function_call_output",
              call_id: "call-image",
              output: [
                { type: "input_text", text: "inspect this" },
                { type: "input_image", image_url: "data:image/png;base64,AA==" },
              ],
            },
          ],
        },
      })

      const anthropicModel: Provider.Model = {
        ...baseModel,
        id: ModelV2.ID.make("claude-fixture"),
        providerID: ProviderV2.ID.make("anthropic"),
        api: { ...baseModel.api, id: "claude-fixture", url: "https://api.anthropic.com/v1", npm: "@ai-sdk/anthropic" },
      }
      const anthropic = yield* LLMClient.prepare(
        LLMNative.request({ model: anthropicModel, apiKey: "test-anthropic-key", messages: history }),
      )
      expect(anthropic).toMatchObject({
        protocol: "anthropic-messages",
        body: {
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "call-image",
                  content: [
                    { type: "text", text: "inspect this" },
                    {
                      type: "image",
                      source: { type: "base64", media_type: "image/png", data: "AA==" },
                    },
                  ],
                },
              ],
            },
          ],
        },
      })
    }),
  )

  test("maps normalized stream inputs to a native LLM request", () => {
    const messages: ModelMessage[] = [
      {
        role: "system",
        content: "system from messages",
      },
      {
        role: "user",
        content: [
          { type: "text", text: "hello", providerOptions: { openai: { cacheControl: { type: "ephemeral" } } } },
          { type: "file", mediaType: "image/png", filename: "img.png", data: "data:image/png;base64,Zm9v" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: { openai: { encryptedContent: "secret" } } },
          { type: "text", text: "I'll run it" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { command: "ls" },
            providerOptions: { openai: { itemId: "item-1" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
            providerOptions: { openai: { outputId: "output-1" } },
          },
        ],
      },
    ]

    const request = LLMNative.request({
      model: baseModel,
      system: ["agent system"],
      messages,
      tools: {
        bash: tool({
          description: "Run a shell command",
          inputSchema: jsonSchema({
            type: "object",
            properties: {
              command: { type: "string" },
            },
            required: ["command"],
          }),
        }),
      },
      toolChoice: "required",
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 1024,
      providerOptions: { openai: { store: false } },
      headers: { "x-request": "request-header" },
    })

    expect(request.model).toMatchObject({
      id: "gpt-5-mini",
      provider: "openai",
      route: { id: "openai-responses" },
    })
    expect(request.model.route.endpoint.baseURL).toBe("https://api.openai.com/v1")
    expect(request.model.route.defaults.headers).toEqual({
      "x-model": "model-header",
      "x-request": "request-header",
    })
    expect(request.model.route.defaults.limits).toMatchObject({
      context: 128_000,
      output: 32_000,
    })
    expect(request.system).toEqual([
      { type: "text", text: "agent system" },
      { type: "text", text: "system from messages" },
    ])
    expect(request.generation).toMatchObject({
      temperature: 0.2,
      topP: 0.9,
      topK: 40,
      maxTokens: 1024,
    })
    expect(request.providerOptions).toEqual({ openai: { store: false } })
    expect(request.toolChoice).toMatchObject({ type: "required" })
    expect(request.tools).toMatchObject([
      {
        name: "bash",
        description: "Run a shell command",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
        },
      },
    ])
    expect(request.messages).toMatchObject([
      {
        role: "user",
        content: [
          { type: "text", text: "hello", providerMetadata: { openai: { cacheControl: { type: "ephemeral" } } } },
          { type: "media", mediaType: "image/png", filename: "img.png", data: "data:image/png;base64,Zm9v" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerMetadata: { openai: { encryptedContent: "secret" } } },
          { type: "text", text: "I'll run it" },
          {
            type: "tool-call",
            id: "call-1",
            name: "bash",
            input: { command: "ls" },
            providerMetadata: { openai: { itemId: "item-1" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: "call-1",
            name: "bash",
            result: { type: "text", value: "ok" },
            providerMetadata: { openai: { outputId: "output-1" } },
          },
        ],
      },
    ])
  })

  test("maps stored provider metadata to native content metadata", () => {
    const reasoning = Object.assign(
      { type: "reasoning" as const, text: "thinking" },
      {
        providerMetadata: {
          openai: {
            itemId: "rs_1",
            reasoningEncryptedContent: "encrypted-state",
          },
        },
      },
    )
    const request = LLMNative.request({
      model: baseModel,
      messages: [
        {
          role: "assistant",
          content: [reasoning],
        },
      ],
    })

    expect(request.messages).toMatchObject([
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking",
            providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
          },
        ],
      },
    ])
  })

  test("selects native request routes for provider packages", () => {
    const openai = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/openai" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(openai.route.id).toBe("openai-responses")
    expect(openai.route.endpoint.baseURL).toBe("https://api.openai.com/v1")

    const anthropic = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/anthropic" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(anthropic.route.id).toBe("anthropic-messages")
    expect(anthropic.route.endpoint.baseURL).toBe("https://api.anthropic.com/v1")

    const google = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@ai-sdk/google" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(google.route.id).toBe("gemini")
    expect(google.route.endpoint.baseURL).toBe("https://generativelanguage.googleapis.com/v1beta")

    const compatible = LLMNative.model({
      model: {
        ...baseModel,
        providerID: ProviderV2.ID.make("opencode"),
        api: { ...baseModel.api, url: "https://ai.example.test/v1", npm: "@ai-sdk/openai-compatible" },
      },
      apiKey: "test-key",
      messages: [],
    })
    expect(compatible.route.id).toBe("openai-compatible-chat")
    expect(compatible.route.endpoint.baseURL).toBe("https://ai.example.test/v1")

    const openrouter = LLMNative.model({
      model: { ...baseModel, api: { ...baseModel.api, url: "", npm: "@openrouter/ai-sdk-provider" } },
      apiKey: "test-key",
      messages: [],
    })
    expect(openrouter.route.id).toBe("openrouter")
    expect(openrouter.route.endpoint.baseURL).toBe("https://openrouter.ai/api/v1")
  })

  test("fails fast for unsupported provider packages", () => {
    expect(() =>
      LLMNative.request({
        model: { ...baseModel, api: { ...baseModel.api, npm: "unknown-provider" } },
        messages: [],
      }),
    ).toThrow("Native LLM request adapter does not support provider package unknown-provider")
  })

  test("only enables native runtime for supported OpenAI API-key models", () => {
    expect(LLMNativeRuntime.status({ model: baseModel, provider: providerInfo, auth: undefined })).toMatchObject({
      type: "supported",
      apiKey: "test-openai-key",
    })
    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, providerID: ProviderV2.ID.make("opencode") },
        provider: { ...providerInfo, id: ProviderV2.ID.make("opencode") },
        auth: undefined,
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "test-openai-key",
    })
    expect(
      LLMNativeRuntime.status({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("opencode"),
          api: { ...baseModel.api, npm: "@ai-sdk/openai-compatible" },
        },
        provider: { ...providerInfo, id: ProviderV2.ID.make("opencode") },
        auth: undefined,
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "test-openai-key",
    })
    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, providerID: ProviderV2.ID.make("google") },
        provider: { ...providerInfo, id: ProviderV2.ID.make("google") },
        auth: undefined,
      }),
    ).toEqual({ type: "unsupported", reason: "provider is not openai, opencode, or anthropic" })
    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: providerInfo,
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
      }),
    ).toEqual({ type: "unsupported", reason: "OAuth auth requires a provider fetch override" })
    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: { ...providerInfo, options: { apiKey: OAUTH_DUMMY_KEY, fetch: async () => new Response() } },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: 1 },
      }),
    ).toMatchObject({ type: "supported", apiKey: OAUTH_DUMMY_KEY })

    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, api: { ...baseModel.api, npm: "@ai-sdk/google" } },
        provider: providerInfo,
        auth: undefined,
      }),
    ).toEqual({ type: "unsupported", reason: "provider package is not OpenAI, OpenAI-compatible, or Anthropic" })

    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: { ...providerInfo, options: {} },
        auth: undefined,
      }),
    ).toEqual({ type: "unsupported", reason: "API key is not configured" })
  })

  test("enables native runtime for Anthropic API-key models", () => {
    expect(
      LLMNativeRuntime.status({
        model: {
          ...baseModel,
          providerID: ProviderV2.ID.make("anthropic"),
          api: { ...baseModel.api, npm: "@ai-sdk/anthropic", url: "https://api.anthropic.com/v1" },
        },
        provider: {
          ...providerInfo,
          id: ProviderV2.ID.make("anthropic"),
          name: "Anthropic",
          env: ["ANTHROPIC_API_KEY"],
          options: { apiKey: "test-anthropic-key" },
        },
        auth: undefined,
      }),
    ).toMatchObject({ type: "supported", apiKey: "test-anthropic-key" })
  })

  test("prefers console provider api key over stored opencode auth", () => {
    expect(
      LLMNativeRuntime.status({
        model: { ...baseModel, providerID: ProviderV2.ID.make("opencode") },
        provider: {
          ...providerInfo,
          id: ProviderV2.ID.make("opencode"),
          options: { apiKey: "console-token" },
          key: "zen-token",
        },
        auth: { type: "api", key: "zen-token" },
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "console-token",
    })
    expect(
      LLMNativeRuntime.status({
        model: baseModel,
        provider: { ...providerInfo, options: {}, key: "provider-key" },
        auth: undefined,
      }),
    ).toMatchObject({
      type: "supported",
      apiKey: "provider-key",
    })
  })

  it.effect("native tool wrapper converts thrown errors into typed ToolFailure", () =>
    Effect.gen(function* () {
      const wrapped = LLMNativeRuntime.nativeTools(
        {
          explode: {
            description: "always throws",
            inputSchema: jsonSchema({ type: "object" }),
            execute: async () => {
              throw new Error("boom")
            },
          } satisfies Tool,
        },
        { messages: [] as ModelMessage[], abort: new AbortController().signal },
      )

      const failure = yield* Effect.flip(wrapped.explode.execute({}, { id: "call-1", name: "explode" }))
      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toBe("boom")
    }),
  )

  it.effect("native tool wrapper raises ToolFailure when the source tool has no execute handler", () =>
    Effect.gen(function* () {
      // The AI SDK Tool shape allows execute to be omitted (e.g., client-side / MCP tools).
      // The native runtime owns execution, so encountering such a tool here means upstream
      // wiring is wrong; we want a typed failure, not a silent skip or unhandled exception.
      const wrapped = LLMNativeRuntime.nativeTools(
        { incomplete: { description: "no execute", inputSchema: jsonSchema({ type: "object" }) } satisfies Tool },
        { messages: [] as ModelMessage[], abort: new AbortController().signal },
      )

      const failure = yield* Effect.flip(wrapped.incomplete.execute({}, { id: "call-1", name: "incomplete" }))
      expect(failure).toBeInstanceOf(ToolFailure)
      expect(failure.message).toContain("incomplete")
    }),
  )

  it.effect("emits native tool calls before overlapping local settlements complete", () =>
    Effect.gen(function* () {
      const observed: string[] = []
      const started: string[] = []
      let release: (() => void) | undefined
      let notifyStarted: (() => void) | undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const bothStarted = new Promise<void>((resolve) => {
        notifyStarted = resolve
      })
      const lookup = {
        description: "Lookup data",
        inputSchema: jsonSchema({ type: "object" }),
        execute: async (_args: unknown, options: { toolCallId: string }) => {
          started.push(options.toolCallId)
          if (started.length === 2) notifyStarted?.()
          await gate
          return { output: options.toolCallId }
        },
      } satisfies Tool
      const llmClient = {
        prepare: () => Effect.die("unused"),
        stream: () =>
          Stream.fromIterable([
            LLMEvent.toolCall({ id: "call-1", name: "lookup", input: {} }),
            LLMEvent.toolCall({ id: "call-2", name: "lookup", input: {} }),
            LLMEvent.finish({ reason: "tool-calls" }),
          ]),
        generate: () => Effect.die("unused"),
      } as LLMClientShape
      const native = LLMNativeRuntime.stream({
        model: baseModel,
        provider: providerInfo,
        auth: undefined,
        llmClient,
        messages: [],
        tools: { lookup },
        headers: {},
        abort: new AbortController().signal,
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") throw new Error(native.reason)

      const fiber = yield* native.stream.pipe(
        Stream.runForEach((event) => Effect.sync(() => observed.push(event.type))),
        Effect.forkScoped,
      )
      yield* Effect.promise(() => bothStarted)

      expect(started).toEqual(["call-1", "call-2"])
      expect(observed).toEqual(["tool-call", "tool-call", "finish"])

      release?.()
      yield* Fiber.join(fiber)
      expect(observed).toEqual(["tool-call", "tool-call", "finish", "tool-result", "tool-result"])
    }),
  )

  it.effect("compiles through the native OpenAI Responses route", () =>
    expectOpenAIResponsesRequest({
      history: [storedSession.user("hello")],
      providerOptions: { openai: { store: false, instructions: "You are concise." } },
      maxOutputTokens: 512,
      headers: { "x-request": "request-header" },
      expectedBody: {
        model: "gpt-5-mini",
        instructions: "You are concise.",
        input: [openAIResponses.user("hello")],
        max_output_tokens: 512,
        store: false,
        stream: true,
      },
    }),
  )

  it.effect("omits non-persisted OpenAI reasoning ids without encrypted state", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.user("What changed?"),
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerOptions",
            itemId: "rs_1",
            encryptedContent: null,
          }),
          storedSession.text("The parser changed."),
        ]),
        storedSession.user("Summarize it."),
      ],
      providerOptions: { openai: { store: false } },
      expectedBody: {
        input: [
          openAIResponses.user("What changed?"),
          openAIResponses.assistant("The parser changed."),
          openAIResponses.user("Summarize it."),
        ],
        store: false,
      },
    }),
  )

  it.effect("preserves encrypted OpenAI reasoning state through native request lowering", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.user("What changed?"),
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: "encrypted-state",
          }),
          storedSession.text("The parser changed."),
        ]),
        storedSession.user("Summarize it."),
      ],
      providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } },
      expectedBody: {
        input: [
          openAIResponses.user("What changed?"),
          openAIResponses.openaiReasoning("Checked the previous diff.", "encrypted-state"),
          openAIResponses.assistant("The parser changed."),
          openAIResponses.user("Summarize it."),
        ],
        include: ["reasoning.encrypted_content"],
        store: false,
      },
    }),
  )

  it.effect("preserves empty encrypted OpenAI reasoning items before tool output", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.assistant([
          storedSession.openaiReasoning("", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: "encrypted-state",
          }),
        ]),
      ],
      providerOptions: { openai: { store: false, include: ["reasoning.encrypted_content"] } },
      expectedBody: {
        input: [{ type: "reasoning", summary: [], encrypted_content: "encrypted-state" }],
        include: ["reasoning.encrypted_content"],
        store: false,
      },
    }),
  )

  it.effect("references stored OpenAI reasoning items by id", () =>
    expectOpenAIResponsesRequest({
      history: [
        storedSession.assistant([
          storedSession.openaiReasoning("Checked the previous diff.", {
            storedAs: "providerMetadata",
            itemId: "rs_1",
            encryptedContent: null,
          }),
        ]),
      ],
      providerOptions: { openai: { store: true } },
      expectedBody: {
        input: [{ type: "item_reference", id: "rs_1" }],
        store: true,
      },
    }),
  )

  it.effect("uses provider fetch override for native OpenAI OAuth requests", () =>
    Effect.gen(function* () {
      const captures: Array<{ url: string; body: unknown }> = []
      const customFetch = Object.assign(
        async (input: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => {
          const request = input instanceof Request ? input : new Request(input, init)
          captures.push({ url: request.url, body: await request.clone().json() })
          return responsesStream([
            { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
            { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 1 } } },
          ])
        },
        { preconnect: () => undefined },
      ) satisfies typeof fetch

      const llmClient = yield* LLMClient.Service
      const native = LLMNativeRuntime.stream({
        model: baseModel,
        provider: { ...providerInfo, options: { apiKey: OAUTH_DUMMY_KEY, fetch: customFetch } },
        auth: { type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 },
        llmClient,
        messages: [{ role: "user", content: "hello" }],
        tools: {},
        providerOptions: { instructions: "You are concise." },
        headers: {},
        abort: new AbortController().signal,
      })
      expect(native.type).toBe("supported")
      if (native.type === "unsupported") throw new Error(native.reason)
      const events = Array.from(yield* native.stream.pipe(Stream.runCollect))

      expect(captures).toHaveLength(1)
      expect(captures[0]).toMatchObject({
        url: "https://api.openai.com/v1/responses",
        body: {
          model: "gpt-5-mini",
          instructions: "You are concise.",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        },
      })
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "text-delta", text: "Hello" }),
          expect.objectContaining({ type: "finish" }),
        ]),
      )
    }),
  )
})
