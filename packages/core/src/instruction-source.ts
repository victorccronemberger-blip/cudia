export * as InstructionSource from "./instruction-source"

import { Config, Context, Effect, Layer, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { makeGlobalNode } from "./effect/app-node"
import { httpClient } from "./effect/app-node-platform"
import { FSUtil } from "./fs-util"
import { BoundedFile } from "./util/bounded-file"

export const DEFAULT_LIMITS = {
  maxSourceBytes: 64 * 1024,
  maxTotalBytes: 256 * 1024,
  maxSources: 64,
  timeoutMs: 5_000,
}

export interface Limits {
  readonly maxSourceBytes: number
  readonly maxTotalBytes: number
  readonly maxSources: number
  readonly timeoutMs: number
}

export type Source =
  | { readonly kind: "file"; readonly path: string; readonly optional?: boolean }
  | { readonly kind: "url"; readonly url: string }

export interface Contribution {
  readonly kind: "file" | "url"
  readonly source: string
  readonly text: string
  readonly rendered: string
  readonly inputBytes: number
}

export class Error extends Schema.TaggedErrorClass<Error>()("InstructionSourceError", {
  kind: Schema.Literals(["file", "url", "discovery"]),
  source: Schema.String,
  reason: Schema.Literals([
    "source_bytes",
    "total_bytes",
    "sources",
    "unavailable",
    "changed",
    "not_file",
    "malformed_utf8",
    "timeout",
    "http_status",
  ]),
  maximum: Schema.optional(Schema.Number),
  observedBytes: Schema.optional(Schema.Number),
  status: Schema.optional(Schema.Number),
}) {
  override get message() {
    const reason = {
      source_bytes: `source exceeds the ${this.maximum}-byte input limit`,
      total_bytes: `complete instruction batch exceeds its ${this.maximum}-byte budget including source headers`,
      sources: `instruction discovery exceeds its ${this.maximum}-source limit`,
      unavailable: "source is unavailable; check its path, access, or connection",
      changed: "source changed during acquisition; retry after it is stable",
      not_file: "source is not a regular file",
      malformed_utf8: "source is not valid UTF-8",
      timeout: `request and body exceeded the ${this.maximum} ms deadline`,
      http_status: `request returned HTTP ${this.status}`,
    }[this.reason]
    return `Cannot load ${this.kind} instructions from ${this.source}: ${reason}. No partial instruction batch was admitted. Reduce an oversized source or correct the source and retry.`
  }
}

export interface Interface {
  readonly limits: Limits
  readonly load: (
    sources: ReadonlyArray<Source>,
    options?: { readonly http?: HttpClient.HttpClient },
  ) => Effect.Effect<ReadonlyArray<Contribution>, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstructionSource") {}

const configured = (name: string, maximum: number) =>
  Config.schema(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(maximum)), name).pipe(
    Config.withDefault(maximum),
  )

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const client = yield* HttpClient.HttpClient
    const limits = yield* Effect.all({
      maxSourceBytes: configured("CUDIA_INSTRUCTION_MAX_SOURCE_BYTES", DEFAULT_LIMITS.maxSourceBytes),
      maxTotalBytes: configured("CUDIA_INSTRUCTION_MAX_TOTAL_BYTES", DEFAULT_LIMITS.maxTotalBytes),
      maxSources: configured("CUDIA_INSTRUCTION_MAX_SOURCES", DEFAULT_LIMITS.maxSources),
      timeoutMs: configured("CUDIA_INSTRUCTION_TIMEOUT_MS", DEFAULT_LIMITS.timeoutMs),
    }).pipe(Effect.orDie)
    return Service.of({ limits, load: (sources, options) => load(fs, options?.http ?? client, limits, sources) })
  }),
)

/** Acquisition is sequential so the aggregate bound also limits retained source bodies. */
export const load = Effect.fn("InstructionSource.load")(function* (
  fs: FSUtil.Interface,
  http: HttpClient.HttpClient,
  limits: Limits,
  sources: ReadonlyArray<Source>,
) {
  if (sources.length > limits.maxSources)
    return yield* new Error({
      kind: "discovery",
      source: "ambient instructions",
      reason: "sources",
      maximum: limits.maxSources,
    })
  const result: Contribution[] = []
  let total = 0
  for (const source of sources) {
    const identifier =
      source.kind === "file"
        ? yield* fs.realPath(source.path).pipe(
            Effect.catchIf(
              (error) => source.optional === true && "reason" in error && error.reason._tag === "NotFound",
              () => Effect.succeed(undefined),
            ),
            Effect.mapError(() => new Error({ kind: "file", source: source.path, reason: "unavailable" })),
          )
        : source.url
    if (identifier === undefined) continue
    const diagnostic = source.kind === "file" ? identifier : remoteIdentifier(identifier)
    const header = `Instructions from: ${identifier}\n`
    const framing = Buffer.byteLength(header, "utf8") + (result.length === 0 ? 0 : 2)
    const available = limits.maxTotalBytes - total - framing
    if (available < 0)
      return yield* new Error({
        kind: source.kind,
        source: diagnostic,
        reason: "total_bytes",
        maximum: limits.maxTotalBytes,
      })
    const maximum = Math.min(limits.maxSourceBytes, available)
    const overflow = (observedBytes?: number) =>
      new Error({
        kind: source.kind,
        source: diagnostic,
        reason: maximum < limits.maxSourceBytes ? "total_bytes" : "source_bytes",
        maximum: maximum < limits.maxSourceBytes ? limits.maxTotalBytes : limits.maxSourceBytes,
        ...(observedBytes === undefined ? {} : { observedBytes }),
      })
    const bytes =
      source.kind === "file"
        ? yield* BoundedFile.read(fs, identifier, maximum).pipe(
            Effect.mapError((error) =>
              error instanceof BoundedFile.LimitError
                ? overflow()
                : new Error({
                    kind: "file",
                    source: diagnostic,
                    reason:
                      error instanceof BoundedFile.SourceError && error.reason !== "range"
                        ? error.reason
                        : "unavailable",
                  }),
            ),
          )
        : yield* remote(http, identifier, diagnostic, maximum, limits.timeoutMs, overflow)
    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes),
      catch: () =>
        new Error({ kind: source.kind, source: diagnostic, reason: "malformed_utf8", observedBytes: bytes.byteLength }),
    })
    const rendered = header + text
    total += framing + Buffer.byteLength(text, "utf8")
    if (total > limits.maxTotalBytes) return yield* overflow(bytes.byteLength)
    result.push({ kind: source.kind, source: identifier, text, rendered, inputBytes: bytes.byteLength })
    yield* Effect.logDebug("Ambient instruction source acquired", {
      kind: source.kind,
      source: diagnostic,
      inputBytes: bytes.byteLength,
      contributionBytes: framing + Buffer.byteLength(text, "utf8"),
    })
  }
  return result
})

const remote = Effect.fn("InstructionSource.remote")(function* (
  http: HttpClient.HttpClient,
  url: string,
  identifier: string,
  maximum: number,
  timeoutMs: number,
  overflow: (observedBytes?: number) => Error,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const scoped = HttpClient.withScope(http)
      const response = yield* scoped.execute(HttpClientRequest.get(url))
      if (response.status < 200 || response.status >= 300)
        return yield* new Error({ kind: "url", source: identifier, reason: "http_status", status: response.status })
      if (response.status === 204 || response.status === 205) return Buffer.alloc(0)
      const chunks: Uint8Array[] = []
      let size = 0
      yield* Stream.runForEach(response.stream, (chunk) => {
        if (chunk.byteLength === 0) return Effect.void
        size += chunk.byteLength
        if (size > maximum) return Effect.fail(overflow(size))
        chunks.push(Buffer.from(chunk))
        return Effect.void
      })
      return Buffer.concat(chunks, size)
    }),
  ).pipe(
    Effect.mapError((error) =>
      error instanceof Error
        ? error
        : new Error({
            kind: "url",
            source: identifier,
            reason: error.reason._tag === "StatusCodeError" ? "http_status" : "unavailable",
            ...(error.reason._tag === "StatusCodeError" ? { status: error.reason.response.status } : {}),
          }),
    ),
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () =>
        Effect.fail(
          new Error({
            kind: "url",
            source: identifier,
            reason: "timeout",
            maximum: timeoutMs,
          }),
        ),
    }),
  )
})

/** Diagnostics do not echo URL credentials or query/fragment secrets. Requests and rendered attribution stay unchanged. */
export function remoteIdentifier(source: string) {
  if (!URL.canParse(source)) return "invalid configured URL"
  const url = new URL(source)
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  return url.href
}

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, httpClient] })
