import { describe, expect, test } from "bun:test"
import { ClientError } from "@opencode-ai/runtime-client"
import { URL } from "node:url"
import { nativeResponse } from "./native-response.fixture"
import { createNativeFileReader, presentNativeFileNodes } from "./native-files"

function startServer(
  fetch: (request: Request) => InstanceType<typeof nativeResponse> | Promise<InstanceType<typeof nativeResponse>>,
) {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch })
}

function stubFetch(
  run: (request: RequestInfo | URL, init?: RequestInit) => Promise<InstanceType<typeof nativeResponse>>,
): typeof globalThis.fetch {
  return Object.assign(run, { preconnect: () => undefined })
}

async function wasCancelled(cancelled: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    cancelled.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 1_000)
    }),
  ]).finally(() => clearTimeout(timer))
}

describe("createNativeFileReader", () => {
  test("sends the raw file route, shared auth, and encoded path and location values", async () => {
    const requests: Array<{ url: string; authorization: string | null; requestID: string | null }> = []
    const server = startServer((request) => {
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        requestID: request.headers.get("x-request-id"),
      })
      if (request.headers.get("authorization") !== "Bearer fixture-secret")
        return new nativeResponse("unauthorized", { status: 401 })
      return new nativeResponse("contents", { headers: { "content-type": "text/plain; charset=utf-8" } })
    })

    try {
      const unauthenticated = createNativeFileReader({ baseUrl: server.url.href, fetch: Bun.fetch })
      await expect(unauthenticated({ path: "file.txt", location: { directory: "/workspace" } })).rejects.toMatchObject({
        name: "ClientError",
        reason: "UnexpectedStatus",
        cause: { status: 401 },
      })
      const read = createNativeFileReader({
        baseUrl: server.url.href,
        fetch: Bun.fetch,
        headers: { authorization: "Bearer fixture-secret" },
      })
      const result = await read(
        {
          path: "dir/a b%20#?\\雪.txt",
          location: { directory: "/workspace/猫 #?%20", workspace: "workspace/#?%20" },
        },
        { headers: { "x-request-id": "fixture" } },
      )

      expect(result).toEqual({ type: "text", content: "contents", mimeType: "text/plain" })
      const request = requests[1]
      if (!request) throw new Error("file request required")
      const url = new URL(request.url)
      expect(url.pathname).toBe("/api/fs/read/dir/a%20b%2520%23%3F%5C%E9%9B%AA.txt")
      expect(url.searchParams.get("location[directory]")).toBe("/workspace/猫 #?%20")
      expect(url.searchParams.get("location[workspace]")).toBe("workspace/#?%20")
      expect(request.authorization).toBe("Bearer fixture-secret")
      expect(request.requestID).toBe("fixture")
      expect(
        await read({ path: "dir/%2e%2e.txt", location: { directory: "/workspace", workspace: "workspace" } }),
      ).toEqual({ type: "text", content: "contents", mimeType: "text/plain" })
      expect(new URL(requests.at(-1)?.url ?? "").pathname).toBe("/api/fs/read/dir/%252e%252e.txt")
      expect(await read({ path: "C:relative.txt", location: { directory: "/workspace" } })).toEqual({
        type: "text",
        content: "contents",
        mimeType: "text/plain",
      })
      expect(new URL(requests.at(-1)?.url ?? "").pathname).toBe("/api/fs/read/C%3Arelative.txt")
    } finally {
      await server.stop(true)
    }
  })

  test("preserves BOM, whitespace, and empty UTF-8 text while encoding binary bytes", async () => {
    const encoder = new TextEncoder()
    const payloads = new Map<string, { bytes: Uint8Array; contentType?: string }>([
      ["bom", { bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("hello\n")]), contentType: "text/plain" }],
      ["whitespace", { bytes: encoder.encode(" \t\n  "), contentType: "text/plain; charset=utf-8" }],
      ["empty", { bytes: new Uint8Array() }],
      ["nul", { bytes: new Uint8Array([0x61, 0x00, 0x62]), contentType: "application/x-test" }],
      ["invalid", { bytes: new Uint8Array([0xff, 0xfe]), contentType: "text/plain" }],
      ["large", { bytes: Uint8Array.from({ length: 262_145 }, (_, index) => (index * 31) % 256) }],
    ])
    const server = startServer((request) => {
      const name = new URL(request.url).searchParams.get("location[directory]")?.split("/").at(-1)
      const payload = name ? payloads.get(name) : undefined
      return new nativeResponse(payload?.bytes ? payload.bytes.slice().buffer : new ArrayBuffer(0), {
        headers: payload?.contentType ? { "content-type": payload.contentType } : undefined,
      })
    })

    try {
      const read = createNativeFileReader({ baseUrl: server.url.href, fetch: Bun.fetch })
      const input = (name: string) => ({ path: "file.dat", location: { directory: `/fixture/${name}` } })

      expect(await read(input("bom"))).toEqual({ type: "text", content: "\uFEFFhello\n", mimeType: "text/plain" })
      expect(await read(input("whitespace"))).toEqual({ type: "text", content: " \t\n  ", mimeType: "text/plain" })
      expect(await read(input("empty"))).toEqual({ type: "text", content: "", mimeType: "application/octet-stream" })
      expect(await read(input("nul"))).toEqual({
        type: "binary",
        content: "YQBi",
        encoding: "base64",
        mimeType: "application/x-test",
      })
      expect(await read(input("invalid"))).toEqual({
        type: "binary",
        content: "//4=",
        encoding: "base64",
        mimeType: "text/plain",
      })
      const large = payloads.get("large")?.bytes
      if (!large) throw new Error("large fixture required")
      expect(await read(input("large"))).toEqual({
        type: "binary",
        content: Buffer.from(large).toString("base64"),
        encoding: "base64",
        mimeType: "application/octet-stream",
      })
    } finally {
      await server.stop(true)
    }
  })

  test("cancels response bodies for non-200 statuses", async () => {
    let resolveCancelled = () => {}
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve
    })
    const fetch = stubFetch(
      async () =>
        new nativeResponse(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("server error body"))
            },
            cancel() {
              resolveCancelled()
            },
          }),
          { status: 503, headers: { "content-type": "text/plain" } },
        ),
    )
    const read = createNativeFileReader({ baseUrl: "http://fixture.invalid", fetch })

    await expect(read({ path: "file.txt", location: { directory: "/workspace" } })).rejects.toMatchObject({
      name: "ClientError",
      reason: "UnexpectedStatus",
      cause: { status: 503 },
    } satisfies Partial<ClientError>)
    expect(await wasCancelled(cancelled)).toBe(true)
  })

  test("aborts while waiting for a deferred body read and cancels the stream", async () => {
    let resolveStarted = () => {}
    let resolveCancelled = () => {}
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve
    })
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve
    })
    const fetch = stubFetch(
      async () =>
        new nativeResponse(
          new ReadableStream<Uint8Array>({
            pull() {
              resolveStarted()
            },
            cancel() {
              resolveCancelled()
            },
          }),
        ),
    )
    const controller = new AbortController()
    const read = createNativeFileReader({ baseUrl: "http://fixture.invalid", fetch })
    const pending = read({ path: "file.txt", location: { directory: "/workspace" } }, { signal: controller.signal })
    await started
    controller.abort()

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(await wasCancelled(cancelled)).toBe(true)
  })

  test("cancels a response when a custom fetch resolves after its signal was aborted", async () => {
    let resolveResponse: (response: InstanceType<typeof nativeResponse>) => void = () => {}
    let resolveCancelled = () => {}
    const cancelled = new Promise<void>((resolve) => {
      resolveCancelled = resolve
    })
    const fetch = stubFetch(
      () => new Promise<InstanceType<typeof nativeResponse>>((resolve) => (resolveResponse = resolve)),
    )
    const controller = new AbortController()
    const read = createNativeFileReader({ baseUrl: "http://fixture.invalid", fetch })
    const pending = read({ path: "file.txt", location: { directory: "/workspace" } }, { signal: controller.signal })
    controller.abort()
    resolveResponse(
      new nativeResponse(
        new ReadableStream<Uint8Array>({
          cancel() {
            resolveCancelled()
          },
        }),
      ),
    )

    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(await wasCancelled(cancelled)).toBe(true)
  })

  test("rejects unsafe relative paths before making a request", async () => {
    let requests = 0
    const fetch = stubFetch(async () => {
      requests += 1
      return new nativeResponse("unexpected")
    })
    const read = createNativeFileReader({ baseUrl: "http://fixture.invalid", fetch })
    const invalid = [
      { path: "", directory: "/workspace" },
      { path: ".", directory: "/workspace" },
      { path: "./", directory: "/workspace" },
      { path: "..", directory: "/workspace" },
      { path: "../secret", directory: "/workspace" },
      { path: "segment/../secret", directory: "/workspace" },
      { path: "/absolute", directory: "/workspace" },
      { path: "C:/drive", directory: "C:\\repo" },
      { path: "C:relative.txt", directory: "C:\\repo" },
      { path: "..\\secret", directory: "C:\\workspace" },
    ]

    for (const item of invalid) {
      await expect(read({ path: item.path, location: { directory: item.directory } })).rejects.toMatchObject({
        cause: "InvalidRelativeFilePath",
      })
    }
    expect(requests).toBe(0)
  })

  test("projects native file nodes without inventing ignore metadata", () => {
    const posix = presentNativeFileNodes("/workspace", [{ path: "src\\literal.txt", type: "file" }])
    const windows = presentNativeFileNodes("C:\\workspace", [{ path: "src\\item.txt", type: "file" }])

    expect(posix).toEqual([
      { name: "src\\literal.txt", path: "src\\literal.txt", absolute: "/workspace/src\\literal.txt", type: "file" },
    ])
    expect(Object.hasOwn(posix[0] ?? {}, "ignored")).toBe(false)
    expect(windows).toEqual([
      { name: "item.txt", path: "src/item.txt", absolute: "C:/workspace/src/item.txt", type: "file" },
    ])
    expect(Object.hasOwn(windows[0] ?? {}, "ignored")).toBe(false)
  })
})
