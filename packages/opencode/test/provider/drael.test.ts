import { expect, test } from "bun:test"
import { drael } from "@opencode-ai/core/drael"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { jsonSchema, streamText } from "ai"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"

test("native Drael preserves 128k, tool support and the supported reasoning levels", () => {
  const provider = Provider.fromModelsDevProvider(drael)
  const model = provider.models["drael-v1"]
  expect(provider.env).toEqual(["DRAEL_KEY", "DRAEL_API_KEY"])
  expect(model.api).toEqual({ id: "drael-v1", url: "https://drael.sh/v1", npm: "@ai-sdk/openai-compatible" })
  expect(model.limit.context).toBe(131072)
  expect(model.capabilities.toolcall).toBe(true)
  expect(model.capabilities.interleaved).toEqual({ field: "reasoning_content" })
  expect(model.variants).toEqual({
    low: { reasoningEffort: "low" },
    medium: { reasoningEffort: "medium" },
    high: { reasoningEffort: "high" },
  })
})

test("Drael-compatible streaming carries reasoning and tool calls through the SDK", async () => {
  const requests: { path: string; authorization: string | null; body: Record<string, unknown> }[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body: await request.json(),
      })
      const chunk = (delta: object, finish_reason: string | null = null) =>
        `data: ${JSON.stringify({ id: "synthetic", object: "chat.completion.chunk", created: 1, model: "drael-v1", choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      return new Response(
        chunk({ role: "assistant", reasoning_content: "Inspect the catalog." }) +
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "call_catalog",
                type: "function",
                function: { name: "kali_catalog", arguments: '{"query":"help"}' },
              },
            ],
          }) +
          chunk({}, "tool_calls") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  try {
    const metadata = Provider.fromModelsDevProvider(drael).models["drael-v1"]
    const model = createOpenAICompatible({ name: "drael", baseURL: `${server.url.origin}/v1`, apiKey: "dk-synthetic" })(
      metadata.api.id,
    )
    const result = streamText({
      model,
      prompt: "Inspect the available tools.",
      maxRetries: 0,
      providerOptions: ProviderTransform.providerOptions(metadata, { reasoningEffort: "high" }),
      tools: {
        kali_catalog: {
          inputSchema: jsonSchema({ type: "object", properties: { query: { type: "string" } }, required: ["query"] }),
        },
      },
    })
    expect(await result.reasoningText).toBe("Inspect the catalog.")
    expect(await result.toolCalls).toMatchObject([{ toolName: "kali_catalog", input: { query: "help" } }])
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      path: "/v1/chat/completions",
      authorization: "Bearer dk-synthetic",
      body: { model: "drael-v1", stream: true, reasoning_effort: "high" },
    })
  } finally {
    server.stop(true)
  }
})
