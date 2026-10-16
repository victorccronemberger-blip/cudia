export * as ContextAudit from "./audit"

import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { Cause, Context, DateTime, Effect, Layer, Ref, Schema, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { ContextManifest } from "./context-manifest"
import { HarnessPolicy } from "./policy"
import { ContextTrace } from "./trace"
import { ContextManifestSchema } from "@opencode-ai/schema/context-manifest"

export const FILE = "cudia-context-latest.json"
export const MAX_CONTENT_BYTES = 65_536
export const MAX_MANIFEST_BYTES = 65_536
export const MAX_REPORT_BYTES = 524_288

export type Input = {
  readonly runtime: "v1-ai-sdk" | "v1-native" | "v2"
  readonly sessionID: string
  readonly agent: string
  readonly model: { readonly provider: string; readonly id: string }
  readonly purpose?: "main" | "compaction"
  /** Reserved result-message ID for this attempt; capture does not establish successful completion. */
  readonly compactionMessageID?: string
  readonly trace?: ContextTrace.Capture
  readonly instructions: ReadonlyArray<{
    readonly source: string
    readonly text: string
    readonly manifest?: unknown
    readonly messageID?: string
    readonly baselineSeq?: number
  }>
  readonly messages: ReadonlyArray<{ readonly role: string }>
  readonly messageSources?: ReadonlyArray<{
    readonly source: string
    readonly role: string
    readonly messageIndex: number
    readonly partIndex: number
    readonly messageID?: string
    readonly text: string
  }>
  readonly tools: ReadonlyArray<{
    readonly name: string
    readonly description?: string
    readonly inputSchema?: unknown
  }>
}

export const Report = Schema.Struct({
  version: Schema.Literal(2),
  boundary: Schema.Literal("prepared request before provider adapter; not a wire capture"),
  runtime: Schema.Literals(["v1-ai-sdk", "v1-native", "v2"]),
  time: Schema.String,
  sessionID: Schema.String,
  agent: Schema.String,
  model: Schema.Struct({ provider: Schema.String, id: Schema.String }),
  purpose: Schema.optional(Schema.Literals(["main", "compaction"])),
  compactionMessageID: Schema.optional(Schema.String),
  contextMode: Schema.Literals(["standard", "lean"]),
  contentIncluded: Schema.Boolean,
  trace: Schema.optional(ContextTrace.CaptureSchema),
  traceOmission: Schema.optional(Schema.Struct({ reason: Schema.Literal("byte_limit"), records: Schema.Number })),
  instructions: Schema.Array(
    Schema.Struct({
      source: Schema.String,
      bytes: Schema.Number,
      sha256: Schema.String,
      originState: Schema.Literals(["valid", "missing", "invalid", "omitted"]),
      contextManifest: Schema.optional(ContextManifestSchema.Manifest),
      originOmission: Schema.optional(Schema.Struct({ reason: Schema.Literal("byte_limit"), bytes: Schema.Number })),
      messageID: Schema.optional(Schema.String),
      baselineSeq: Schema.optional(Schema.Number),
      content: Schema.optional(Schema.String),
      contentOmitted: Schema.optional(Schema.Boolean),
    }),
  ),
  instructionCount: Schema.Number,
  instructionBytes: Schema.Number,
  messageCount: Schema.Number,
  messageRoles: Schema.Record(Schema.String, Schema.Number),
  messageSources: Schema.optional(
    Schema.Array(
      Schema.Struct({
        source: Schema.String,
        role: Schema.String,
        messageIndex: Schema.Number,
        partIndex: Schema.Number,
        messageID: Schema.optional(Schema.String),
        bytes: Schema.Number,
        sha256: Schema.String,
        content: Schema.optional(Schema.String),
        contentOmitted: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
  messageSourceCount: Schema.optional(Schema.Number),
  messageSourceBytes: Schema.optional(Schema.Number),
  omittedMessageSources: Schema.optional(Schema.Number),
  toolCount: Schema.Number,
  toolDefinitionBytes: Schema.Number,
  tools: Schema.Array(Schema.Struct({ name: Schema.String, bytes: Schema.Number })),
  omittedTools: Schema.optional(Schema.Number),
  omittedInstructions: Schema.optional(Schema.Number),
})
export type Report = typeof Report.Type

const LegacyInstruction = Schema.Struct({
  source: Schema.String,
  bytes: Schema.Number,
  sha256: Schema.String,
  content: Schema.optional(Schema.String),
  contentOmitted: Schema.optional(Schema.Boolean),
})

export const LegacyReport = Schema.Struct({
  ...Report.fields,
  version: Schema.Literal(1),
  boundary: Schema.String,
  instructions: Schema.Array(LegacyInstruction),
})

/** Accepts persisted v1 captures for readers while new writes remain v2. */
export const StoredReport = Schema.Union([Report, LegacyReport])
export type StoredReport = typeof StoredReport.Type

export function report(input: Input, policy: HarnessPolicy.Interface, time: string): Report {
  let remaining = policy.auditMode === "content" ? MAX_CONTENT_BYTES : 0
  let remainingManifestBytes = MAX_MANIFEST_BYTES
  const instructions = input.instructions.slice(0, 128).map((item) => {
    const bytes = Buffer.byteLength(item.text, "utf8")
    const include = policy.auditMode === "content" && bytes <= remaining
    if (include) remaining -= bytes
    // Validity checks pair consistency and structure; origin hashes describe observed input, not proof of identity.
    const originState = ContextManifest.verify(item.text, item.manifest)
    const manifest =
      originState === "valid" ? Schema.decodeUnknownOption(ContextManifestSchema.Manifest)(item.manifest) : undefined
    const manifestBytes = manifest?._tag === "Some" ? Buffer.byteLength(JSON.stringify(manifest.value), "utf8") : 0
    const includeManifest = manifest?._tag === "Some" && manifestBytes <= remainingManifestBytes
    const reportedOriginState: "valid" | "missing" | "invalid" | "omitted" =
      originState === "valid" && !includeManifest ? "omitted" : originState
    if (includeManifest) remainingManifestBytes -= manifestBytes
    return {
      source: item.source.slice(0, 160),
      bytes,
      sha256: createHash("sha256").update(item.text).digest("hex"),
      originState: reportedOriginState,
      ...(includeManifest && manifest?._tag === "Some" ? { contextManifest: manifest.value } : {}),
      ...(originState === "valid" && !includeManifest
        ? { originOmission: { reason: "byte_limit" as const, bytes: manifestBytes } }
        : {}),
      ...(item.messageID !== undefined ? { messageID: item.messageID } : {}),
      ...(item.baselineSeq !== undefined ? { baselineSeq: item.baselineSeq } : {}),
      ...(include ? { content: item.text } : {}),
      ...(policy.auditMode === "content" && !include ? { contentOmitted: true } : {}),
    }
  })
  const messageSources: NonNullable<Report["messageSources"]>[number][] = []
  for (const item of input.messageSources?.slice(0, 128) ?? []) {
    const bytes = Buffer.byteLength(item.text, "utf8")
    const metadata = {
      source: item.source.slice(0, 160),
      role: item.role,
      messageIndex: item.messageIndex,
      partIndex: item.partIndex,
      ...(item.messageID === undefined ? {} : { messageID: item.messageID }),
      bytes,
      sha256: createHash("sha256").update(item.text).digest("hex"),
      ...(policy.auditMode === "content" ? { contentOmitted: true } : {}),
    }
    // Message attribution shares the metadata allowance and raw content shares the instruction allowance.
    const metadataBytes = Buffer.byteLength(JSON.stringify(metadata), "utf8")
    if (metadataBytes > remainingManifestBytes) continue
    remainingManifestBytes -= metadataBytes
    const include = policy.auditMode === "content" && bytes <= remaining
    if (include) remaining -= bytes
    const { contentOmitted, ...entry } = metadata
    messageSources.push({
      ...entry,
      ...(include ? { content: item.text } : contentOmitted ? { contentOmitted } : {}),
    })
  }
  // Count the actual normalized definitions, without persisting descriptions or schemas.
  const tools = input.tools.map((tool) => ({
    name: tool.name,
    bytes: Buffer.byteLength(JSON.stringify(tool), "utf8"),
  }))
  // Trace observations, message attribution, and instruction manifests share one metadata allowance.
  const trace = input.trace ? boundedTrace(input.trace, remainingManifestBytes) : undefined
  return {
    version: 2,
    boundary: "prepared request before provider adapter; not a wire capture",
    runtime: input.runtime,
    time,
    sessionID: input.sessionID,
    agent: input.agent,
    model: input.model,
    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
    ...(input.compactionMessageID === undefined ? {} : { compactionMessageID: input.compactionMessageID }),
    contextMode: policy.contextMode,
    contentIncluded: policy.auditMode === "content",
    ...(trace?.value ? { trace: trace.value } : {}),
    ...(trace?.omitted ? { traceOmission: { reason: "byte_limit" as const, records: trace.omitted } } : {}),
    instructions,
    instructionCount: input.instructions.length,
    instructionBytes: input.instructions.reduce((sum, item) => sum + Buffer.byteLength(item.text, "utf8"), 0),
    messageCount: input.messages.length,
    messageRoles: input.messages.reduce<Record<string, number>>((counts, message) => {
      counts[message.role] = (counts[message.role] ?? 0) + 1
      return counts
    }, {}),
    ...(input.messageSources === undefined
      ? {}
      : {
          messageSources,
          messageSourceCount: input.messageSources.length,
          messageSourceBytes: input.messageSources.reduce((sum, item) => sum + Buffer.byteLength(item.text, "utf8"), 0),
          ...(input.messageSources.length > messageSources.length
            ? { omittedMessageSources: input.messageSources.length - messageSources.length }
            : {}),
        }),
    toolCount: tools.length,
    toolDefinitionBytes: tools.reduce((sum, item) => sum + item.bytes, 0),
    tools: tools.slice(0, 256).map((tool) => ({ ...tool, name: tool.name.slice(0, 256) })),
    ...(tools.length > 256 ? { omittedTools: tools.length - 256 } : {}),
    ...(input.instructions.length > instructions.length
      ? { omittedInstructions: input.instructions.length - instructions.length }
      : {}),
  }
}

function boundedTrace(input: ContextTrace.Capture, remaining: number) {
  const records: Array<ContextTrace.Capture["records"][number]> = []
  const value = { ...input, records, omitted: input.omitted + input.records.length }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > remaining)
    return { omitted: input.omitted + input.records.length }
  for (const record of input.records) {
    records.push(record)
    value.omitted -= 1
    if (Buffer.byteLength(JSON.stringify(value), "utf8") <= remaining) continue
    records.pop()
    value.omitted += 1
    break
  }
  return { value, omitted: input.records.length - records.length }
}

export interface Interface {
  readonly enabled: boolean
  readonly record: (input: Input) => Effect.Effect<void>
  readonly latest: () => Effect.Effect<Report | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@cudia/ContextAudit") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const policy = yield* HarnessPolicy.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const latest = yield* Ref.make<Report | undefined>(undefined)
    const serial = yield* Semaphore.make(1)
    const file = path.join(global.state, FILE)
    return Service.of({
      enabled: policy.auditMode !== "off",
      latest: () => Ref.get(latest),
      record: (input) => {
        if (policy.auditMode === "off") return Effect.void
        return Effect.gen(function* () {
          const now = yield* DateTime.nowAsDate
          const value = report(input, policy, now.toISOString())
          const serialized = JSON.stringify(value, null, 2)
          if (Buffer.byteLength(serialized, "utf8") > MAX_REPORT_BYTES) {
            yield* Effect.logWarning("CUDIA context audit exceeds its byte limit; capture skipped")
            return
          }
          // The latest file keeps its existing content/metadata contract.
          const temporary = file + `.${randomUUID()}.tmp`
          yield* serial
            .withPermit(
              Effect.gen(function* () {
                yield* fs.ensureDir(global.state)
                yield* fs
                  .writeFileString(temporary, serialized, { mode: 0o600, flag: "wx" })
                  .pipe(
                    Effect.andThen(fs.rename(temporary, file)),
                    Effect.ensuring(fs.remove(temporary).pipe(Effect.ignore)),
                  )
                yield* Ref.set(latest, value)
              }),
            )
            .pipe(Effect.catch((error) => Effect.logWarning("Could not save CUDIA context audit", { error })))
          if (!policy.auditHistory) return
          // History has a separate opt-in, metadata allowlist, transaction and failure boundary.
          // Do not hold the latest-file permit while waiting for a history database lock.
          yield* Effect.gen(function* () {
            const history = yield* Effect.tryPromise(() => import("./audit-history"))
            const saved = yield* history.append(path.join(global.state, history.FILE), value)
            if (!saved.maintenance) yield* Effect.logWarning("CUDIA context history reclamation deferred")
          }).pipe(
            Effect.catchTag("ContextHistoryError", (error) =>
              Effect.logWarning("Could not save CUDIA context history", { reason: error.reason }),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterrupts(cause)
                ? Effect.interrupt
                : Effect.logWarning("Could not save CUDIA context history", { reason: "unavailable" }),
            ),
          )
        })
      },
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [HarnessPolicy.node, FSUtil.node, Global.node] })
