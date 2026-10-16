import { describe, expect } from "bun:test"
import { ConfigProvider, Effect, Fiber, Layer } from "effect"
import { adjust } from "effect/testing/TestClock"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import path from "node:path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstructionSource } from "@opencode-ai/core/instruction-source"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, LayerNodePlatform.httpClient])))
const limits = { ...InstructionSource.DEFAULT_LIMITS, maxSourceBytes: 128 }

describe("ambient instruction acquisition", () => {
  it.effect("uses explicit defaults and accepts only positive configured lower limits", () =>
    Effect.gen(function* () {
      const policy = (input: Record<string, unknown>) =>
        InstructionSource.Service.pipe(
          Effect.map((service) => service.limits),
          Effect.provide(
            AppNodeBuilder.build(InstructionSource.node).pipe(
              Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(input))),
            ),
          ),
        )
      expect(yield* policy({})).toEqual(InstructionSource.DEFAULT_LIMITS)
      expect(
        yield* policy({ CUDIA_INSTRUCTION_MAX_SOURCE_BYTES: "32", CUDIA_INSTRUCTION_MAX_SOURCES: "2" }),
      ).toMatchObject({ maxSourceBytes: 32, maxSources: 2 })
      expect((yield* policy({ CUDIA_INSTRUCTION_MAX_TOTAL_BYTES: "0" }).pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* policy({ CUDIA_INSTRUCTION_MAX_SOURCE_BYTES: "65537" }).pipe(Effect.exit))._tag).toBe("Failure")
    }),
  )

  it.live("preserves source ordering, BOM and exact bytes, and counts complete framing in the aggregate cap", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const http = yield* HttpClient.HttpClient
      const directory = yield* fs.makeTempDirectoryScoped()
      const first = path.join(directory, "first.md")
      const second = path.join(directory, "second.md")
      yield* fs.writeFileString(first, "\uFEFFone 😀\r\n")
      yield* fs.writeFileString(second, "second")
      const sources = [
        { kind: "file" as const, path: first },
        { kind: "file" as const, path: second },
      ]
      const result = yield* InstructionSource.load(fs, http, limits, sources)
      expect(result.map((item) => item.source)).toEqual([first, second])
      expect(result[0]?.text).toBe("\uFEFFone 😀\r\n")
      expect(result[0]?.inputBytes).toBe(Buffer.byteLength("\uFEFFone 😀\r\n"))
      const total = Buffer.byteLength(result.map((item) => item.rendered).join("\n\n"))
      expect(yield* InstructionSource.load(fs, http, { ...limits, maxTotalBytes: total }, sources)).toEqual(result)
      const failed = yield* InstructionSource.load(fs, http, { ...limits, maxTotalBytes: total - 1 }, sources).pipe(
        Effect.flip,
      )
      expect(failed).toMatchObject({ kind: "file", reason: "total_bytes", maximum: total - 1 })
      expect(failed.message).toContain("No partial instruction batch")
    }),
  )

  it.live("distinguishes optional absence from required absence, wrong kind and malformed UTF-8", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const http = yield* HttpClient.HttpClient
      const directory = yield* fs.makeTempDirectoryScoped()
      const missing = path.join(directory, "missing.md")
      expect(
        yield* InstructionSource.load(fs, http, limits, [{ kind: "file", path: missing, optional: true }]),
      ).toEqual([])
      expect(
        yield* InstructionSource.load(fs, http, limits, [{ kind: "file", path: missing }]).pipe(Effect.flip),
      ).toMatchObject({ kind: "file", reason: "unavailable" })
      expect(
        yield* InstructionSource.load(fs, http, limits, [{ kind: "file", path: directory }]).pipe(Effect.flip),
      ).toMatchObject({ reason: "not_file" })
      const malformed = path.join(directory, "malformed.md")
      yield* fs.writeFile(malformed, Uint8Array.of(0x61, 0x80))
      expect(
        yield* InstructionSource.load(fs, http, limits, [{ kind: "file", path: malformed }]).pipe(Effect.flip),
      ).toMatchObject({ reason: "malformed_utf8", observedBytes: 2 })
      const tooMany = yield* InstructionSource.load(fs, http, { ...limits, maxSources: 1 }, [
        { kind: "file", path: missing },
        { kind: "file", path: malformed },
      ]).pipe(Effect.flip)
      expect(tooMany).toMatchObject({ kind: "discovery", reason: "sources", maximum: 1 })
    }),
  )

  it.live(
    "caps actual chunked and gzip-delivered bytes, handles empty HTTP responses, and rejects status failures",
    () =>
      Effect.acquireUseRelease(
        Effect.sync(() =>
          Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: (request) => {
              const route = new URL(request.url).pathname
              if (route === "/empty") return new Response(null, { status: 204 })
              if (route === "/failure") return new Response("PRIVATE_FAILED_BODY", { status: 403 })
              if (route === "/gzip")
                return new Response(Bun.gzipSync("z".repeat(400)), { headers: { "content-encoding": "gzip" } })
              if (route === "/chunked")
                return new Response(
                  new ReadableStream({
                    start(controller) {
                      controller.enqueue(new TextEncoder().encode("x".repeat(80)))
                      controller.enqueue(new TextEncoder().encode("y".repeat(80)))
                      controller.close()
                    },
                  }),
                )
              return new Response("\uFEFFremote 😀\r\n")
            },
          }),
        ),
        (server) =>
          Effect.gen(function* () {
            const fs = yield* FSUtil.Service
            const http = yield* HttpClient.HttpClient
            const source = (route: string) => [{ kind: "url" as const, url: new URL(route, server.url).href }]
            const valid = yield* InstructionSource.load(fs, http, limits, source("/valid"))
            expect(valid[0]?.text).toBe("\uFEFFremote 😀\r\n")
            expect(valid[0]?.inputBytes).toBe(Buffer.byteLength("\uFEFFremote 😀\r\n"))
            expect((yield* InstructionSource.load(fs, http, limits, source("/empty")))[0]?.text).toBe("")
            const status = yield* InstructionSource.load(
              fs,
              http,
              limits,
              source("/failure?token=DIAGNOSTIC_QUERY_SECRET#hidden"),
            ).pipe(Effect.flip)
            expect(status).toMatchObject({ reason: "http_status", status: 403 })
            expect(status.source).toEndWith("/failure")
            expect(JSON.stringify(status)).not.toContain("DIAGNOSTIC_QUERY_SECRET")
            expect(status.message).not.toContain("PRIVATE_FAILED_BODY")
            for (const route of ["/chunked", "/gzip"]) {
              const error = yield* InstructionSource.load(fs, http, limits, source(route)).pipe(Effect.flip)
              expect(error).toMatchObject({ reason: "source_bytes", maximum: 128 })
              expect(error.observedBytes).toBeGreaterThan(128)
            }
          }),
        (server) => Effect.promise(() => server.stop(true)),
      ),
  )

  it.effect("applies the deadline through stalled body consumption and cancels its reader", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const state = { cancelled: 0, signal: undefined as AbortSignal | undefined }
      let ready: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        ready = resolve
      })
      const http = HttpClient.make((request, _url, signal) =>
        Effect.sync(() => {
          state.signal = signal
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new TextEncoder().encode("started"))
                },
                pull() {
                  ready?.()
                },
                cancel() {
                  state.cancelled++
                },
              }),
            ),
          )
        }),
      )
      const task = yield* InstructionSource.load(fs, http, { ...limits, timeoutMs: 50 }, [
        { kind: "url", url: "https://fixture.test/stalled" },
      ]).pipe(Effect.forkChild)
      yield* Effect.promise(() => started)
      yield* adjust(51)
      const error = yield* Fiber.join(task).pipe(Effect.flip)
      expect(error).toMatchObject({ kind: "url", reason: "timeout", maximum: 50 })
      expect(state.cancelled).toBe(1)
      expect(state.signal?.aborted).toBe(true)
    }),
  )

  it.effect("preserves interruption, releases a started remote body and redacts diagnostic credentials", () =>
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const state = { cancelled: 0, signal: undefined as AbortSignal | undefined }
      let ready: (() => void) | undefined
      const started = new Promise<void>((resolve) => {
        ready = resolve
      })
      const http = HttpClient.make((request, _url, signal) =>
        Effect.sync(() => {
          state.signal = signal
          return HttpClientResponse.fromWeb(
            request,
            new Response(
              new ReadableStream({
                pull() {
                  ready?.()
                },
                cancel() {
                  state.cancelled++
                },
              }),
            ),
          )
        }),
      )
      const task = yield* InstructionSource.load(fs, http, limits, [
        { kind: "url", url: "https://fixture.test/interrupt" },
      ]).pipe(Effect.forkChild)
      yield* Effect.promise(() => started)
      yield* Fiber.interrupt(task)
      expect((yield* Fiber.await(task))._tag).toBe("Failure")
      expect(state.cancelled).toBe(1)
      expect(state.signal?.aborted).toBe(true)
      expect(InstructionSource.remoteIdentifier("https://user:secret@example.test/rules?key=secret#secret")).toBe(
        "https://example.test/rules",
      )
    }),
  )
})
