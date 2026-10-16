import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { MessageID, SessionID } from "../../src/session/schema"
import { Agent } from "../../src/agent/agent"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Truncate } from "../../src/tool/truncate"
import { Tool } from "../../src/tool/tool"
import {
  WebSearchTool,
  selectWebSearchProvider,
  webSearchModelName,
  webSearchProviderLabel,
} from "../../src/tool/websearch"

import { it, testEffect } from "../lib/effect"

const requests: Array<{ readonly url: string; readonly body: unknown }> = []
const permissionRequests: string[] = []
const payload = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { content: [{ type: "text", text: "results" }] },
})
const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array" ? JSON.parse(new TextDecoder().decode(request.body.body)) : undefined
      requests.push({ url: request.url, body })
    }).pipe(Effect.andThen(Effect.succeed(HttpClientResponse.fromWeb(request, new Response(payload))))),
  ),
)
const webSearchTest = testEffect(
  LayerNode.compile(LayerNode.group([httpClient, Agent.node, Truncate.node, RuntimeFlags.node]), [
    [httpClient, http],
    [RuntimeFlags.node, RuntimeFlags.layer({ enableExa: true })],
  ]),
)
const context = {
  sessionID: SessionID.make("ses_websearch_validation"),
  messageID: MessageID.make("msg_websearch_validation"),
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: (input: { permission: string }) => Effect.sync(() => permissionRequests.push(input.permission)),
} satisfies Tool.Context

const SESSION_ID = "ses_0196aabbccddeeff001122334455"

describe("websearch provider", () => {
  test("selects a stable provider per session", () => {
    expect(selectWebSearchProvider(SESSION_ID)).toBe(selectWebSearchProvider(SESSION_ID))
  })

  test("supports an operational override", () => {
    const original = process.env.OPENCODE_WEBSEARCH_PROVIDER

    try {
      process.env.OPENCODE_WEBSEARCH_PROVIDER = "parallel"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("parallel")

      process.env.OPENCODE_WEBSEARCH_PROVIDER = "exa"
      expect(selectWebSearchProvider(SESSION_ID)).toBe("exa")
    } finally {
      if (original === undefined) delete process.env.OPENCODE_WEBSEARCH_PROVIDER
      else process.env.OPENCODE_WEBSEARCH_PROVIDER = original
    }
  })

  test("routes to Exa when the Exa flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: true, parallel: false })).toBe("exa")
  })

  test("routes to Parallel when the Parallel flag is enabled", () => {
    expect(selectWebSearchProvider(SESSION_ID, { exa: false, parallel: true })).toBe("parallel")
  })

  test("uses branded labels", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
    expect(webSearchProviderLabel(undefined)).toBe("Web Search")
  })

  test("uses the provider API model id for Parallel analytics", () => {
    expect(
      webSearchModelName({
        model: {
          id: "claude-opus-4-7",
          api: { id: "claude-opus-4.7" },
        },
      }),
    ).toBe("claude-opus-4.7")
  })
})

describe("websearch input bounds", () => {
  webSearchTest.instance("rejects invalid limits before permission/HTTP and accepts documented maximums", () =>
    Effect.gen(function* () {
      requests.length = 0
      permissionRequests.length = 0
      const info = yield* WebSearchTool
      const tool = yield* info.init()
      expect(requests).toEqual([])
      expect(permissionRequests).toEqual([])
      const execute = tool.execute as unknown as (input: unknown, ctx: Tool.Context) => ReturnType<typeof tool.execute>
      const invalid = [
        { query: "q", numResults: 0 },
        { query: "q", numResults: -1 },
        { query: "q", numResults: 1.5 },
        { query: "q", numResults: 21 },
        { query: "q", contextMaxCharacters: 0 },
        { query: "q", contextMaxCharacters: -1 },
        { query: "q", contextMaxCharacters: 1.5 },
        { query: "q", contextMaxCharacters: 50_001 },
      ]

      for (const input of invalid) {
        const exit = yield* execute(input, context).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(exit.cause.reasons.some(Cause.isDieReason)).toBe(true)
      }
      expect(permissionRequests).toEqual([])
      expect(requests).toEqual([])

      const result = yield* tool.execute(
        { query: "current libraries", numResults: 20, contextMaxCharacters: 50_000 },
        context,
      )

      expect(result.output).toBe("results")
      expect(permissionRequests).toEqual(["websearch"])
      expect(requests.length).toBeGreaterThan(0)
      const provider = selectWebSearchProvider(context.sessionID, { exa: true, parallel: false })
      const requestArguments =
        provider === "exa"
          ? { query: "current libraries", numResults: 20, contextMaxCharacters: 50_000 }
          : {
              objective: "current libraries",
              search_queries: ["current libraries"],
              session_id: context.sessionID,
            }
      expect(requests).toContainEqual(
        expect.objectContaining({
          url: provider === "exa" ? "https://mcp.exa.ai/mcp" : "https://search.parallel.ai/mcp",
          body: expect.objectContaining({
            params: expect.objectContaining({
              arguments: expect.objectContaining(requestArguments),
            }),
          }),
        }),
      )

      requests.length = 0
      permissionRequests.length = 0
      const defaults = yield* tool.execute({ query: "default options" }, context)
      expect(defaults.output).toBe("results")
      expect(permissionRequests).toEqual(["websearch"])
      expect(requests.length).toBeGreaterThan(0)
      if (provider === "exa") {
        expect(requests).toContainEqual(
          expect.objectContaining({
            body: expect.objectContaining({
              params: expect.objectContaining({
                arguments: expect.objectContaining({ query: "default options", numResults: 8 }),
              }),
            }),
          }),
        )
      } else {
        expect(requests).toContainEqual(
          expect.objectContaining({
            body: expect.objectContaining({
              params: expect.objectContaining({
                arguments: expect.objectContaining({
                  objective: "default options",
                  search_queries: ["default options"],
                }),
              }),
            }),
          }),
        )
      }
    }),
  )
})
