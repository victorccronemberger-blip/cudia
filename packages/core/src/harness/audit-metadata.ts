import type { Report } from "./audit"
import type { ContextManifestSchema } from "@opencode-ai/schema/context-manifest"
import type { ContextTrace } from "./trace"

/** Explicit allowlist: new report fields do not silently extend historical retention. */
export function metadata(value: Report): Report {
  return {
    version: 2,
    boundary: value.boundary,
    runtime: value.runtime,
    time: value.time,
    sessionID: value.sessionID,
    agent: value.agent,
    model: { provider: value.model.provider, id: value.model.id },
    ...(value.purpose === undefined ? {} : { purpose: value.purpose }),
    ...(value.compactionMessageID === undefined ? {} : { compactionMessageID: value.compactionMessageID }),
    ...(value.captureID === undefined ? {} : { captureID: value.captureID }),
    ...(value.historySnapshot === undefined
      ? {}
      : {
          historySnapshot: {
            id: value.historySnapshot.id,
            stage: value.historySnapshot.stage,
            mapping: value.historySnapshot.mapping,
            sourceCount: value.historySnapshot.sourceCount,
            sourceBytes: value.historySnapshot.sourceBytes,
            ...(value.historySnapshot.omittedSources === undefined
              ? {}
              : { omittedSources: value.historySnapshot.omittedSources }),
            sources: value.historySnapshot.sources.map((source) => ({
              source: source.source,
              role: source.role,
              messageID: source.messageID,
              partID: source.partID,
              messageIndex: source.messageIndex,
              partIndex: source.partIndex,
              bytes: source.bytes,
              sha256: source.sha256,
            })),
          },
        }),
    contextMode: value.contextMode,
    contentIncluded: false,
    ...(value.trace ? { trace: trace(value.trace) } : {}),
    ...(value.traceOmission
      ? { traceOmission: { reason: value.traceOmission.reason, records: value.traceOmission.records } }
      : {}),
    instructions: value.instructions.map((item) => ({
      source: item.source,
      bytes: item.bytes,
      sha256: item.sha256,
      originState: item.originState,
      ...(item.contextManifest ? { contextManifest: manifest(item.contextManifest) } : {}),
      ...(item.originOmission
        ? { originOmission: { reason: item.originOmission.reason, bytes: item.originOmission.bytes } }
        : {}),
      ...(item.messageID === undefined ? {} : { messageID: item.messageID }),
      ...(item.baselineSeq === undefined ? {} : { baselineSeq: item.baselineSeq }),
    })),
    instructionCount: value.instructionCount,
    instructionBytes: value.instructionBytes,
    messageCount: value.messageCount,
    messageRoles: Object.fromEntries(Object.entries(value.messageRoles)),
    ...(value.messageSources === undefined
      ? {}
      : {
          messageSources: value.messageSources.map((item) => ({
            source: item.source,
            role: item.role,
            messageIndex: item.messageIndex,
            partIndex: item.partIndex,
            ...(item.messageID === undefined ? {} : { messageID: item.messageID }),
            bytes: item.bytes,
            sha256: item.sha256,
          })),
        }),
    ...(value.messageSourceCount === undefined ? {} : { messageSourceCount: value.messageSourceCount }),
    ...(value.messageSourceBytes === undefined ? {} : { messageSourceBytes: value.messageSourceBytes }),
    ...(value.omittedMessageSources === undefined ? {} : { omittedMessageSources: value.omittedMessageSources }),
    toolCount: value.toolCount,
    toolDefinitionBytes: value.toolDefinitionBytes,
    tools: value.tools.map((item) => ({ name: item.name, bytes: item.bytes })),
    ...(value.omittedTools === undefined ? {} : { omittedTools: value.omittedTools }),
    ...(value.omittedInstructions === undefined ? {} : { omittedInstructions: value.omittedInstructions }),
  }
}

function manifest(value: ContextManifestSchema.Manifest): ContextManifestSchema.Manifest {
  return {
    version: value.version,
    hashEncoding: value.hashEncoding,
    length: value.length,
    bytes: value.bytes,
    sha256: value.sha256,
    parts: value.parts.map((part) => ({
      producer: part.producer,
      phase: part.phase,
      start: part.start,
      end: part.end,
      origins: part.origins.map((origin) => ({
        kind: origin.kind,
        id: origin.id,
        start: origin.start,
        end: origin.end,
        ...(origin.sha256 === undefined ? {} : { sha256: origin.sha256 }),
        ...(origin.bytes === undefined ? {} : { bytes: origin.bytes }),
      })),
    })),
  }
}

function snapshot(value: ContextTrace.Snapshot): ContextTrace.Snapshot {
  return value.status === "complete"
    ? { status: value.status, bytes: value.bytes, sha256: value.sha256 }
    : { status: value.status, reason: value.reason }
}

function trace(value: ContextTrace.Capture): ContextTrace.Capture {
  return {
    version: value.version,
    coverage: value.coverage,
    omitted: value.omitted,
    records: value.records.map((record) => ({
      ordinal: record.ordinal,
      stage: record.stage,
      projection: record.projection,
      source: {
        kind: record.source.kind,
        id: record.source.id,
        ordinal: record.source.ordinal,
        ...(record.source.entry === undefined ? {} : { entry: record.source.entry }),
      },
      status: record.status,
      before: snapshot(record.before),
      ...(record.after ? { after: snapshot(record.after) } : {}),
      change: record.change,
    })),
  }
}
