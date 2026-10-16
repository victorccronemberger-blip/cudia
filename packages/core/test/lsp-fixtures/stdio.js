import { pathToFileURL } from "node:url"
import path from "node:path"

const documents = new Map()
const events = []
const mode = process.env.LSP_MODE ?? "normal"
const control = process.env.LSP_CONTROL
let buffer = Buffer.alloc(0)
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
const event = (value) =>
  control
    ? fetch(`${control}/event`, { method: "POST", body: JSON.stringify(value) }).catch(() => {})
    : Promise.resolve()
const send = (value) => {
  const body = Buffer.from(JSON.stringify(value))
  const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
  if (mode === "fragment") {
    for (let offset = 0; offset < frame.length; offset += 3) process.stdout.write(frame.subarray(offset, offset + 3))
    return
  }
  process.stdout.write(frame)
}
const respond = (id, result) => send({ jsonrpc: "2.0", id, result })
const burst = (messages) =>
  process.stdout.write(
    Buffer.concat(
      messages.map((message) => {
        const body = Buffer.from(JSON.stringify(message))
        return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
      }),
    ),
  )
const item = (uri) => ({ name: "symbol", kind: 12, uri, range, selectionRange: range, data: { opaque: "preserve-me" } })

await event({ type: "started", pid: process.pid, cwd: process.cwd() })
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length) {
    const end = buffer.indexOf("\r\n\r\n")
    if (end < 0) return
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1])
    if (buffer.length < end + 4 + length) return
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString())
    buffer = buffer.subarray(end + 4 + length)
    void receive(message)
  }
})

async function receive(message) {
  const params = message.params
  events.push(message.method)
  void event({ type: "message", method: message.method, id: message.id, params })
  if (message.method === "initialize") {
    if (mode === "init-hang") return
    if (mode === "init-hold") await fetch(`${control}/hold`, { method: "POST", body: JSON.stringify({ id: -2 }) })
    if (mode === "oversized") {
      process.stdout.write("Content-Length: 99999999\r\n\r\n")
      return
    }
    if (mode === "malformed") {
      process.stdout.write("Content-Length: 4\r\n\r\nnope")
      return
    }
    if (mode === "early-exit") {
      await event({ type: "initialize-exit" })
      process.exit(7)
    }
    if (mode === "notification-burst") {
      burst(
        Array.from({ length: 1000 }, (_, index) => ({
          jsonrpc: "2.0",
          method: "window/logMessage",
          params: { type: 3, message: `notification-${index}` },
        })),
      )
      // Await the writable callback: initialization only proceeds after the stderr
      // pipe accepts the complete burst, proving the client drains it concurrently.
      await new Promise((resolve) => process.stderr.write(Buffer.alloc(1024 * 1024, 120), resolve))
    }
    respond(message.id, {
      capabilities: {
        positionEncoding: mode === "encoding" ? "utf-8" : "utf-16",
        textDocumentSync: mode === "full" ? 1 : { openClose: true, change: 2 },
        definitionProvider: true,
        referencesProvider: true,
        hoverProvider: mode !== "unsupported",
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        implementationProvider: true,
        callHierarchyProvider: true,
        ...(mode.startsWith("diag-pull")
          ? { diagnosticProvider: { identifier: "fixture", interFileDependencies: false, workspaceDiagnostics: false } }
          : {}),
      },
    })
    if (mode === "backpressure") {
      process.stdin.pause()
      void fetch(`${control}/hold`, { method: "POST", body: JSON.stringify({ id: -1 }) }).then(() =>
        process.stdin.resume(),
      )
    }
    return
  }
  if (message.method === "textDocument/didOpen") {
    documents.set(params.textDocument.uri, { ...params.textDocument, changes: [] })
    void publish(params.textDocument.uri)
    return
  }
  if (message.method === "textDocument/didChange") {
    const document = documents.get(params.textDocument.uri)
    Object.assign(document, params.textDocument, { text: params.contentChanges[0].text })
    document.changes.push(params.contentChanges[0])
    void publish(params.textDocument.uri)
    return
  }
  if (message.method === "textDocument/didClose") {
    documents.delete(params.textDocument.uri)
    return
  }
  if (message.method === "$/cancelRequest") return
  if (message.method === "shutdown") return respond(message.id, null)
  if (message.method === "exit") {
    process.exit(0)
  }
  if (message.id === undefined) return
  if (mode === "request-burst" && message.method === "textDocument/hover") {
    burst(
      Array.from({ length: 1000 }, (_, index) => ({
        jsonrpc: "2.0",
        id: `burst-${index}`,
        method: "workspace/applyEdit",
        params: { edit: { changes: {} } },
      })),
    )
    return
  }
  const uri = params?.textDocument?.uri ?? pathToFileURL(path.join(process.cwd(), "file.ts")).href
  const external = process.env.LSP_RESULT_URI ?? pathToFileURL(path.join(process.cwd(), "..", "outside.ts")).href
  if (mode === "invalid-result")
    return respond(message.id, [
      { uri: external, range: { start: { line: 0, character: 0 }, end: { line: -1, character: 0 } } },
    ])
  if (message.method === "textDocument/diagnostic") {
    const document = documents.get(uri)
    if (mode === "diag-pull-timeout") return
    if (mode === "diag-pull-hold") await fetch(`${control}/hold`, { method: "POST", body: JSON.stringify({ id: -4 }) })
    const resultId = `result-${document.version}`
    if (mode === "diag-pull-invalid-unchanged") return respond(message.id, { kind: "unchanged", resultId: "stray" })
    if (mode === "diag-pull-rotate") {
      document.pulls = (document.pulls ?? 0) + 1
      const resultId = `rotated-${document.pulls}`
      const kind =
        typeof params.previousResultId === "string" && params.previousResultId === document.resultId
          ? "unchanged"
          : "full"
      document.resultId = resultId
      return respond(message.id, { kind, resultId, ...(kind === "full" ? { items: diagnosticItems(document) } : {}) })
    }
    if (params.previousResultId === resultId) return respond(message.id, { kind: "unchanged", resultId })
    return respond(message.id, { kind: "full", resultId, items: diagnosticItems(document) })
  }
  if (mode === "hold" && message.method === "textDocument/hover") {
    await fetch(`${control}/hold`, { method: "POST", body: JSON.stringify({ id: message.id, uri }) })
  }
  if (mode === "hang" && message.method !== "workspace/symbol") return
  if (mode === "partial") {
    process.stdout.write('Content-Length: 200\r\n\r\n{"jsonrpc":"2.0"')
    return
  }
  if (mode === "post-malformed") {
    process.stdout.write("Content-Length: 99999999\r\n\r\n")
    return
  }
  if (mode === "deep") {
    const body = `{"jsonrpc":"2.0","id":${message.id},"result":{"contents":${"[".repeat(10000)}0${"]".repeat(10000)}}}`
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    return
  }
  if (message.method === "textDocument/hover") {
    if (mode === "apply-edit") {
      send({ jsonrpc: "2.0", id: "server-write", method: "workspace/applyEdit", params: { edit: { changes: {} } } })
    }
    return respond(message.id, {
      contents: {
        kind: "plaintext",
        value: JSON.stringify({ document: documents.get(uri), position: params.position, pid: process.pid, events }),
      },
    })
  }
  if (message.method === "textDocument/definition" || message.method === "textDocument/implementation")
    return respond(message.id, [
      { uri, range },
      { targetUri: external, targetRange: range, targetSelectionRange: range },
    ])
  if (message.method === "textDocument/references")
    return respond(message.id, [
      { uri, range },
      { uri: external, range },
    ])
  if (message.method === "textDocument/documentSymbol")
    return respond(message.id, [{ name: "symbol", kind: 12, range, selectionRange: range }])
  if (message.method === "workspace/symbol")
    return respond(message.id, [
      { name: "symbol", kind: 12, location: { uri, range } },
      { name: "external", kind: 12, location: { uri: external, range } },
    ])
  if (message.method === "textDocument/prepareCallHierarchy") return respond(message.id, [item(uri), item(external)])
  if (message.method === "callHierarchy/incomingCalls")
    return respond(message.id, [
      { from: params.item, fromRanges: [range] },
      { from: item(external), fromRanges: [range] },
    ])
  if (message.method === "callHierarchy/outgoingCalls")
    return respond(message.id, [
      { to: params.item, fromRanges: [range] },
      { to: item(external), fromRanges: [range] },
    ])
  if (message.error) await event({ type: "server-response", message })
}

function diagnosticItems(document) {
  return document.text.includes("bad")
    ? [
        {
          range,
          message: `problem-version-${document.version}`,
          severity: 1,
          code: 123,
          source: "fixture",
          tags: [1],
          data: { ignored: true },
          codeDescription: { href: "https://invalid.example" },
          relatedInformation: [{ location: { uri: "file:///outside.ts", range }, message: "external" }],
        },
      ]
    : []
}
async function publish(uri) {
  if (!mode.startsWith("diag-") || mode.startsWith("diag-pull") || mode === "diag-none") return
  const document = { ...documents.get(uri) }
  if (mode === "diag-push-hold" || (mode === "diag-cached-hold" && document.version > 1))
    await fetch(`${control}/hold`, { method: "POST", body: JSON.stringify({ id: -3 }) })
  const diagnostics = diagnosticItems(document)
  const publishedUri =
    process.env.LSP_DIAGNOSTIC_URI ??
    (mode === "diag-uri-alias"
      ? uri
          .replace(/^file:\/\/\/([A-Za-z]):/, (_, drive) => `file:///${drive.toLowerCase()}%3A`)
          .replace(/\/([^/%])([^/]*)$/, (_, first, rest) => `/%${first.charCodeAt(0).toString(16)}${rest}`)
      : uri)
  if (mode === "diag-stale") {
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, version: document.version - 1, diagnostics },
    })
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: { uri, version: document.version + 1, diagnostics },
    })
    return
  }
  if (mode === "diag-push-burst") {
    burst(
      Array.from({ length: 1000 }, (_, index) => ({
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: {
          uri: pathToFileURL(path.join(process.cwd(), `unadmitted-${index}.ts`)).href,
          version: document.version,
          diagnostics,
        },
      })),
    )
  }
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: {
      uri: publishedUri,
      ...(mode === "diag-unversioned" ? {} : { version: document.version }),
      diagnostics: mode === "diag-push-burst" ? Array.from({ length: 1000 }, () => diagnostics[0]) : diagnostics,
    },
  })
  await event({ type: "diagnostic-sent", id: document.version, params: { uri: publishedUri } })
}
