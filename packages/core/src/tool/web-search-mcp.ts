import { Duration, Effect, Pull, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"

export const MAX_RESPONSE_BYTES = 256 * 1024
export const DEFAULT_TIMEOUT = Duration.seconds(25)

const McpRequest = <F extends Schema.Struct.Fields>(args: Schema.Struct<F>) =>
  Schema.Struct({
    jsonrpc: Schema.Literal("2.0"),
    id: Schema.Literal(1),
    method: Schema.Literal("tools/call"),
    params: Schema.Struct({ name: Schema.String, arguments: args }),
  })

type RpcOutcome = { readonly _tag: "Text"; readonly text: string } | { readonly _tag: "Error"; readonly error: string }

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

function parseRpc(payload: string): RpcOutcome | undefined {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch {
    return undefined
  }
  if (!record(value) || value.jsonrpc !== "2.0" || value.id !== 1) return undefined
  if ("error" in value) return { _tag: "Error", error: "MCP server returned a JSON-RPC error" }
  if (!record(value.result)) return { _tag: "Error", error: "MCP server returned an invalid tool result" }
  if (value.result.isError === true) return { _tag: "Error", error: "MCP tool reported an error" }
  if (!Array.isArray(value.result.content)) return { _tag: "Error", error: "MCP tool result has no content" }
  const text = value.result.content
    .flatMap((block) => (record(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : []))
    .join("\n")
  if (!text.trim()) return { _tag: "Error", error: "MCP tool result contains no text" }
  return { _tag: "Text", text }
}

function sseParser() {
  let buffered = ""
  let data: string[] = []

  const line = (value: string): RpcOutcome | undefined => {
    if (value === "") {
      const payload = data.join("\n")
      data = []
      if (!payload) return undefined
      return parseRpc(payload)
    }
    if (value.startsWith(":")) return undefined
    const colon = value.indexOf(":")
    const field = colon < 0 ? value : value.slice(0, colon)
    if (field !== "data") return undefined
    const raw = colon < 0 ? "" : value.slice(colon + 1)
    data.push(raw.startsWith(" ") ? raw.slice(1) : raw)
    return undefined
  }

  return {
    push(value: string, final = false): RpcOutcome | undefined {
      buffered += value
      let start = 0
      for (let index = 0; index < buffered.length; index++) {
        const char = buffered[index]
        if (char !== "\n" && char !== "\r") continue
        if (char === "\r" && index === buffered.length - 1 && !final) break
        const outcome = line(buffered.slice(start, index))
        if (outcome) return outcome
        if (char === "\r" && buffered[index + 1] === "\n") index++
        start = index + 1
      }
      buffered = buffered.slice(start)
      if (final) {
        const outcome = buffered ? line(buffered) : undefined
        buffered = ""
        if (outcome) return outcome
        const payload = data.join("\n")
        data = []
        if (payload) return parseRpc(payload)
      }
      return undefined
    },
  }
}

function readResponse(response: HttpClientResponse.HttpClientResponse, tool: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const contentType = response.headers["content-type"]?.toLowerCase() ?? ""
      const isSse = contentType.includes("text/event-stream")
      const declaredSize = Number(response.headers["content-length"])
      const pull = yield* Stream.toPull(response.stream)
      if (Number.isSafeInteger(declaredSize) && declaredSize > MAX_RESPONSE_BYTES)
        return yield* Effect.fail(new Error(`${tool} response exceeded ${MAX_RESPONSE_BYTES} bytes`))

      const decoder = new TextDecoder()
      const parser = isSse ? sseParser() : undefined
      const chunks: Buffer[] = []
      let size = 0
      while (true) {
        const step = yield* pull.pipe(
          Pull.catchDone(() => Effect.succeed(undefined)),
          Effect.mapError(() => new Error(`${tool} response could not be read`)),
        )
        if (step === undefined) break
        for (const chunk of step) {
          size += chunk.byteLength
          if (size > MAX_RESPONSE_BYTES)
            return yield* Effect.fail(new Error(`${tool} response exceeded ${MAX_RESPONSE_BYTES} bytes`))
          if (parser) {
            const outcome = parser.push(decoder.decode(chunk, { stream: true }))
            if (outcome?._tag === "Error") return yield* Effect.fail(new Error(outcome.error))
            if (outcome?._tag === "Text") return outcome.text
          } else {
            chunks.push(Buffer.from(chunk))
          }
        }
      }

      if (parser) {
        const outcome = parser.push(decoder.decode(), true)
        if (outcome?._tag === "Error") return yield* Effect.fail(new Error(outcome.error))
        if (outcome?._tag === "Text") return outcome.text
        return yield* Effect.fail(new Error(`${tool} response has no matching tool result`))
      }

      const outcome = parseRpc(Buffer.concat(chunks, size).toString("utf8"))
      if (outcome?._tag === "Error") return yield* Effect.fail(new Error(outcome.error))
      if (outcome?._tag === "Text") return outcome.text
      return yield* Effect.fail(new Error(`${tool} response has no matching tool result`))
    }),
  )
}

const closeResponseBody = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.scoped(Stream.toPull(response.stream).pipe(Effect.asVoid))

export const callWebSearchMcp = <F extends Schema.Struct.Fields>(input: {
  readonly http: HttpClient.HttpClient
  readonly url: string
  readonly tool: string
  readonly args: Schema.Struct<F>
  readonly value: Schema.Struct.Type<F>
  readonly headers?: Record<string, string>
  readonly timeout?: Duration.Input
}) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(input.url).pipe(
      HttpClientRequest.accept("application/json, text/event-stream"),
      HttpClientRequest.setHeaders(input.headers ?? {}),
      HttpClientRequest.schemaBodyJson(McpRequest(input.args))({
        jsonrpc: "2.0" as const,
        id: 1 as const,
        method: "tools/call" as const,
        params: { name: input.tool, arguments: input.value },
      }),
    )
    const response = yield* input.http
      .execute(request)
      .pipe(Effect.mapError(() => new Error(`${input.tool} request failed`)))
    if (response.status < 200 || response.status >= 300) {
      yield* closeResponseBody(response)
      return yield* Effect.fail(new Error(`${input.tool} request failed with HTTP ${response.status}`))
    }
    return yield* readResponse(response, input.tool)
  }).pipe(
    Effect.timeoutOrElse({
      duration: input.timeout ?? DEFAULT_TIMEOUT,
      orElse: () => Effect.fail(new Error(`${input.tool} request timed out`)),
    }),
  )
