export * as LSPMutation from "./mutation"

import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "../config"
import { makeLocationNode } from "../effect/app-node"
import { LSPV2 } from "../lsp"

export type Change = { readonly filePath: string; readonly kind: "changed" | "deleted" }

const Position = Schema.Struct({ line: Schema.Number, character: Schema.Number })
const Diagnostic = Schema.Struct({
  range: Schema.Struct({ start: Position, end: Position }),
  message: Schema.String,
  severity: Schema.optional(Schema.Number),
  code: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
  messageTruncated: Schema.optional(Schema.Literal(true)),
})
const File = Schema.Union([
  Schema.Struct({
    filePath: Schema.String,
    state: Schema.Literal("reported"),
    server: Schema.String,
    source: Schema.Literals(["pull", "push", "none"]),
    freshness: Schema.Literals(["current", "unversioned", "pending"]),
    version: Schema.Number,
    generation: Schema.Number,
    diagnostics: Schema.Array(Diagnostic),
    omittedDiagnostics: Schema.Number,
    omittedDetails: Schema.Number,
  }),
  Schema.Struct({ filePath: Schema.String, state: Schema.Literal("closed") }),
  Schema.Struct({ filePath: Schema.String, state: Schema.Literal("error"), failure: LSPV2.Failure.fields.kind }),
])
export const Result = Schema.Struct({
  files: Schema.Array(File),
  omittedFiles: Schema.Number,
  unsupportedFiles: Schema.Number,
  timedOut: Schema.Boolean,
})
export type Result = typeof Result.Type

export interface Interface {
  readonly after: (changes: readonly Change[]) => Effect.Effect<Result | undefined>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/v2/LSP/Mutation") {}

const PREFIX = "\n\nPost-write LSP: "
export const MAX_BYTES = 8192
export const MAX_FILES = 4
export const MAX_DIAGNOSTICS = 20
export const MAX_MESSAGE_BYTES = 512

/** Reports observations made after the commit; it does not identify the exact committed bytes. */
export function make(input: {
  readonly lsp: LSPV2.Interface
  readonly enabled: boolean
  readonly timeout?: number
}): Interface {
  return Service.of({
    after: (changes) =>
      Effect.gen(function* () {
        if (!input.enabled) return
        const unique = new Map<string, Change>()
        for (const change of changes)
          unique.set(process.platform === "win32" ? change.filePath.toLowerCase() : change.filePath, change)
        if (unique.size === 0) return
        // forget is local and synchronous: invalidate even the unselected tail before any server wait.
        for (const change of unique.values()) yield* input.lsp.forget(change)
        const files: (typeof File.Type)[] = []
        let omittedFiles = unique.size
        let unsupportedFiles = 0
        let timedOut = false
        let selected = 0
        let diagnostics = 0
        const fits = (entries: readonly (typeof File.Type)[]) =>
          Buffer.byteLength(
            PREFIX +
              JSON.stringify({
                files: entries,
                omittedFiles: unique.size,
                unsupportedFiles: unique.size,
                timedOut: false,
              }),
          ) <= MAX_BYTES
        const collect = Effect.gen(function* () {
          for (const change of unique.values()) {
            const supported =
              change.kind === "deleted"
                ? { _tag: "Success" as const, success: true }
                : yield* Effect.result(input.lsp.supports(change))
            if (supported._tag === "Success" && !supported.success) {
              unsupportedFiles++
              omittedFiles--
              continue
            }
            if (selected >= MAX_FILES) continue
            selected++
            const outcome =
              supported._tag === "Failure"
                ? supported
                : yield* Effect.result(
                    change.kind === "deleted"
                      ? input.lsp.didClose(change).pipe(Effect.as(undefined))
                      : input.lsp.diagnostics(change),
                  )
            if (outcome._tag === "Failure" || outcome.success === undefined) {
              const entry: typeof File.Type =
                outcome._tag === "Failure"
                  ? { filePath: change.filePath, state: "error", failure: outcome.failure.kind }
                  : { filePath: change.filePath, state: "closed" }
              if (!fits([...files, entry])) continue
              files.push(entry)
              omittedFiles--
              continue
            }
            const report = outcome.success
            const entry = {
              filePath: change.filePath,
              state: "reported" as const,
              server: report.server,
              source: report.source,
              freshness: report.freshness,
              version: report.version,
              generation: report.generation,
              diagnostics: [] as (typeof Diagnostic.Type)[],
              omittedDiagnostics: report.diagnostics.length,
              omittedDetails: report.omitted,
            }
            if (!fits([...files, entry])) continue
            for (const item of report.diagnostics) {
              if (diagnostics >= MAX_DIAGNOSTICS) break
              if (typeof item.code === "string" && Buffer.byteLength(item.code) > MAX_MESSAGE_BYTES) continue
              const message = clip(item.message)
              const diagnostic: typeof Diagnostic.Type = {
                range: item.range,
                message,
                ...(item.severity === undefined ? {} : { severity: item.severity }),
                ...(item.code === undefined ? {} : { code: item.code }),
                ...(message === item.message ? {} : { messageTruncated: true }),
              }
              entry.diagnostics.push(diagnostic)
              if (!fits([...files, entry])) {
                entry.diagnostics.pop()
                continue
              }
              entry.omittedDiagnostics--
              diagnostics++
            }
            files.push(entry)
            omittedFiles--
          }
        })
        yield* collect.pipe(
          Effect.timeoutOrElse({
            duration: input.timeout ?? 3000,
            orElse: () =>
              Effect.sync(() => {
                timedOut = true
              }),
          }),
        )
        if (!timedOut && unsupportedFiles === unique.size) return
        return { files, omittedFiles, unsupportedFiles, timedOut }
      }),
  })
}

function clip(value: string) {
  if (Buffer.byteLength(value) <= MAX_MESSAGE_BYTES) return value
  let bytes = 0
  let output = ""
  for (const character of value) {
    const next = Buffer.byteLength(character)
    if (bytes + next > MAX_MESSAGE_BYTES) break
    bytes += next
    output += character
  }
  return output
}

export function format(result: Result | undefined): string {
  if (result === undefined) return ""
  const output = PREFIX + JSON.stringify(result)
  if (Buffer.byteLength(output) <= MAX_BYTES) return output
  return (
    PREFIX +
    JSON.stringify({
      files: [],
      omittedFiles: result.omittedFiles + result.files.length,
      unsupportedFiles: result.unsupportedFiles,
      timedOut: result.timedOut,
    })
  )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const lsp = yield* LSPV2.Service
    const setting = Config.latest(yield* config.entries(), "lsp")
    return make({ lsp, enabled: setting !== undefined && setting !== false })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node, LSPV2.node] })
