import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { MAX_ENVELOPE_BYTES, loadPublicKeys, readCappedFile, validateEnvelope } from "./lib/manifest.js"
import { renderHome } from "./lib/site.js"

const ROOT = dirname(fileURLToPath(import.meta.url))
const ERROR_BODY = Buffer.from('{"error":"release_unavailable"}')
const NOT_FOUND_BODY = Buffer.from('{"error":"not_found"}')
const METHOD_BODY = Buffer.from('{"error":"method_not_allowed"}')
const DOWNLOAD_BODY = Buffer.from('{"error":"release_artifact_unavailable"}')

export function createUpdateServer(options = {}) {
  const configuredReleaseDir = options.releaseDir ?? process.env.CUDIA_RELEASE_DIR ?? join(ROOT, "releases")
  const releaseDir =
    typeof configuredReleaseDir === "string" && isAbsolute(configuredReleaseDir)
      ? resolve(configuredReleaseDir)
      : undefined
  let keys
  try {
    keys = loadPublicKeys({
      publicKeys: options.publicKeys,
      trustPath: options.trustPath ?? join(ROOT, "trust.json"),
      environmentKeys: options.environmentKeys ?? process.env.CUDIA_RELEASE_PUBLIC_KEYS,
    })
  } catch {
    keys = undefined
  }
  const now = options.now ?? (() => new Date())

  return createServer(async (request, response) => {
    const method = request.method
    let pathname
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname
    } catch {
      return send(response, 404, NOT_FOUND_BODY, method)
    }
    const known =
      pathname === "/" ||
      pathname === "/health" ||
      pathname === "/ready" ||
      pathname === "/download/windows" ||
      pathname === "/updates/v1/stable.json" ||
      pathname === "/updates/v1/preview.json"
    if (!known) return send(response, 404, NOT_FOUND_BODY, method)
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD")
      return send(response, 405, METHOD_BODY, method)
    }
    if (pathname === "/health") return sendJson(response, 200, { status: "ok" }, method)
    if (pathname === "/ready") {
      const ready = await getManifest("stable")
      return ready ? sendJson(response, 200, { ready: true }, method) : send(response, 503, ERROR_BODY, method)
    }
    if (pathname === "/") {
      const [stable, preview] = await Promise.all([getManifest("stable"), getManifest("preview")])
      return sendHtml(response, 200, renderHome({ stable: stable?.payload, preview: preview?.payload }), method)
    }
    if (pathname === "/download/windows") {
      const url = new URL(request.url ?? "/download/windows", "http://localhost")
      const selection = downloadSelection(url.searchParams)
      if (!selection) return send(response, 404, DOWNLOAD_BODY, method)
      const manifest = await getManifest(selection.channel)
      if (!manifest) return send(response, 503, ERROR_BODY, method)
      const artifact = manifest.payload.artifacts.find(
        (item) =>
          item.kind === selection.kind &&
          item.platform === "windows" &&
          item.arch === "x64" &&
          item.variant === selection.variant,
      )
      if (!artifact) return send(response, 404, DOWNLOAD_BODY, method)
      response.setHeader("Cache-Control", "no-store")
      response.setHeader("Location", artifact.url)
      response.setHeader("X-Content-Type-Options", "nosniff")
      response.writeHead(307)
      return response.end()
    }
    const channel = pathname.endsWith("stable.json") ? "stable" : "preview"
    const manifest = await getManifest(channel)
    if (!manifest) return send(response, 503, ERROR_BODY, method)
    response.setHeader("Content-Type", "application/json; charset=utf-8")
    response.setHeader("Cache-Control", "no-store")
    response.setHeader("X-Content-Type-Options", "nosniff")
    response.setHeader("ETag", `"${createHash("sha256").update(manifest.bytes).digest("hex")}"`)
    response.setHeader("Content-Length", String(manifest.bytes.length))
    response.writeHead(200)
    if (method === "HEAD") return response.end()
    return response.end(manifest.bytes)
  })

  async function getManifest(channel) {
    if (!releaseDir || !keys) return undefined
    try {
      const bytes = await readCappedFile(join(releaseDir, `${channel}.json`), MAX_ENVELOPE_BYTES)
      const validated = validateEnvelope(bytes, keys, channel, now())
      return { bytes, payload: validated.payload }
    } catch {
      return undefined
    }
  }
}

function downloadSelection(searchParams) {
  const allowed = new Set(["channel", "variant", "kind"])
  for (const key of searchParams.keys()) {
    if (!allowed.has(key) || searchParams.getAll(key).length !== 1) return undefined
  }
  const channel = searchParams.get("channel") ?? "preview"
  const variant = searchParams.get("variant") ?? "normal"
  const kind = searchParams.get("kind") ?? "installer"
  if (!(["stable", "preview"].includes(channel) && ["normal", "baseline"].includes(variant) && ["installer", "archive"].includes(kind))) {
    return undefined
  }
  return { channel, variant, kind }
}

function sendHtml(response, status, body, method) {
  const bytes = Buffer.from(body)
  response.setHeader("Content-Type", "text/html; charset=utf-8")
  response.setHeader("Cache-Control", "no-store")
  response.setHeader("X-Content-Type-Options", "nosniff")
  response.setHeader("Referrer-Policy", "no-referrer")
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
  response.setHeader("Content-Length", String(bytes.length))
  response.writeHead(status)
  if (method === "HEAD") return response.end()
  return response.end(bytes)
}

function sendJson(response, status, value, method) {
  const body = Buffer.from(JSON.stringify(value))
  response.setHeader("Content-Type", "application/json; charset=utf-8")
  response.setHeader("Cache-Control", "no-store")
  response.setHeader("X-Content-Type-Options", "nosniff")
  response.setHeader("Content-Length", String(body.length))
  response.writeHead(status)
  if (method === "HEAD") return response.end()
  return response.end(body)
}

function send(response, status, body, method) {
  response.setHeader("Content-Type", "application/json; charset=utf-8")
  response.setHeader("Cache-Control", "no-store")
  response.setHeader("X-Content-Type-Options", "nosniff")
  response.setHeader("Content-Length", String(body.length))
  response.writeHead(status)
  if (method === "HEAD") return response.end()
  return response.end(body)
}
