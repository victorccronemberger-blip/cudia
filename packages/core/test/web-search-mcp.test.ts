import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Fiber, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { callWebSearchMcp, MAX_RESPONSE_BYTES } from "../src/tool/web-search-mcp"

const Args = Schema.Struct({ query: Schema.String })
const value = { query: "fixture query" }
const rpc = (result: unknown, id: unknown = 1) => JSON.stringify({ jsonrpc: "2.0", id, result })
const textResult = (texts: string[]) => ({
  content: texts.map((text) => ({ type: "text", text })),
})

const client = (response: () => Response) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, response())))

const call = (response: () => Response, timeout = Duration.seconds(2)) =>
  callWebSearchMcp({
    http: client(response),
    url: "https://example.test/mcp?exaApiKey=fixture-secret",
    tool: "fixture_search",
    args: Args,
    value,
    timeout,
  })

describe("web search MCP transport", () => {
  test("joins every text block and skips non-text content", async () => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        content: [
          { type: "text", text: "first" },
          { type: "image", text: "ignored image text", data: "ignored" },
          { text: "missing content type" },
          { type: "text", text: "second" },
        ],
      },
    })
    expect(await Effect.runPromise(call(() => Response.json(JSON.parse(body))))).toBe("first\nsecond")
  })

  test("parses SSE across byte, UTF-8, CRLF, comment, and multiline data boundaries", async () => {
    const body =
      ': heartbeat\r\nevent: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":1,"result":{"content":[{"type":"text","text":"café 🌎"},\r\ndata: {"type":"text","text":"source"}]}}\r\n\r\n'
    const bytes = new TextEncoder().encode(body)
    const response = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const byte of bytes) controller.enqueue(new Uint8Array([byte]))
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )

    expect(await Effect.runPromise(call(response))).toBe("café 🌎\nsource")
  })

  test("ignores notifications and unrelated IDs, then returns the matching event without waiting for EOF", async () => {
    let cancelled = false
    let started = false
    const response = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n` +
                  `data: ${rpc(textResult(["wrong id"]), 2)}\n\n` +
                  `data: ${rpc(textResult(["ready"]))}\n\n`,
              ),
            )
            started = true
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )

    expect(await Effect.runPromise(call(response))).toBe("ready")
    expect(started).toBe(true)
    expect(cancelled).toBe(true)
  })

  test("fails on JSON-RPC errors, tool errors, empty text, and missing matching IDs", async () => {
    const failures = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "secret must not leak" } }),
      rpc({ isError: true, content: [{ type: "text", text: "provider detail" }] }),
      rpc({ content: [{ type: "image", data: "ignored" }] }),
      rpc(textResult(["unrelated"]), 2),
    ]
    for (const body of failures) {
      await expect(Effect.runPromise(call(() => new Response(body)))).rejects.toThrow()
    }
    await expect(Effect.runPromise(call(() => new Response("")))).rejects.toThrow("no matching tool result")
  })

  test("does not include endpoint credentials or backend response text in errors", async () => {
    const responseError = await Effect.runPromiseExit(
      call(() => Response.json({ jsonrpc: "2.0", id: 1, error: { code: 7, message: "fixture-secret" } })),
    )
    expect(Exit.isFailure(responseError)).toBe(true)
    expect(JSON.stringify(responseError)).not.toContain("fixture-secret")

    const statusError = await Effect.runPromise(call(() => new Response("fixture-secret", { status: 503 }))).catch(
      (error) => String(error),
    )
    expect(statusError).toContain("HTTP 503")
    expect(statusError).not.toContain("fixture-secret")
  })

  test("enforces the 256 KiB cap and cancels an oversized response", async () => {
    let cancelled = false
    const response = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(MAX_RESPONSE_BYTES + 1))
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    await expect(Effect.runPromise(call(response))).rejects.toThrow("exceeded 262144 bytes")
    expect(cancelled).toBe(true)
  })

  test("cancels a body when the declared content length already exceeds the cap", async () => {
    let cancelled = false
    const response = () =>
      new Response(
        new ReadableStream({
          start() {},
          cancel() {
            cancelled = true
          },
        }),
        {
          headers: {
            "content-length": String(MAX_RESPONSE_BYTES + 1),
            "content-type": "text/event-stream",
          },
        },
      )

    await expect(Effect.runPromise(call(response))).rejects.toThrow("exceeded 262144 bytes")
    expect(cancelled).toBe(true)
  })

  test("returns an HTTP status promptly and closes an error response body", async () => {
    let cancelled = false
    const response = () =>
      new Response(
        new ReadableStream({
          start() {},
          cancel() {
            cancelled = true
          },
        }),
        { status: 503, headers: { "content-type": "text/event-stream" } },
      )

    await expect(Effect.runPromise(call(response, Duration.millis(500)))).rejects.toThrow("HTTP 503")
    expect(cancelled).toBe(true)
  })

  test("applies one deadline across response headers and a body that never completes", async () => {
    let cancelled = false
    const response = () =>
      new Response(
        new ReadableStream({
          start() {},
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    await expect(Effect.runPromise(call(response, Duration.millis(30)))).rejects.toThrow("request timed out")
    expect(cancelled).toBe(true)
  })

  test("propagates caller interruption and cancels the active response body", async () => {
    let started: (() => void) | undefined
    const reading = new Promise<void>((resolve) => {
      started = resolve
    })
    let cancelled = false
    const response = () =>
      new Response(
        new ReadableStream({
          start() {
            started?.()
          },
          cancel() {
            cancelled = true
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* call(response).pipe(Effect.forkChild)
        yield* Effect.promise(() => reading)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }),
    )
    expect(Exit.isFailure(result)).toBe(true)
    expect(cancelled).toBe(true)
  })
})
