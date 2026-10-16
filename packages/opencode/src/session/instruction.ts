import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import path from "path"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer, Context, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { HttpClient } from "effect/unstable/http"
import { Config } from "@/config/config"
import { InstanceState } from "@/effect/instance-state"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Flag } from "@opencode-ai/core/flag/flag"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { TextPage } from "@/util/text-page"
import { Global } from "@opencode-ai/core/global"
import { BoundedFile } from "@opencode-ai/core/util/bounded-file"
import { InstructionSource } from "@opencode-ai/core/instruction-source"
import { AmbientInstructions } from "@opencode-ai/core/harness/ambient-instructions"
import type { MessageV2 } from "./message-v2"
import type { MessageID } from "./schema"

export const Page = Schema.Struct({
  filepath: Schema.String,
  contentHash: Schema.String.check(Schema.isPattern(/^[\da-f]{64}$/)),
  offset: NonNegativeInt,
  nextOffset: NonNegativeInt,
  totalLength: NonNegativeInt,
  text: Schema.String,
})
export type Page = Schema.Schema.Type<typeof Page>

export const Batch = Schema.Struct({
  instructions: Schema.Array(Page),
  pending: Schema.Array(Schema.String),
  hasMore: Schema.Boolean,
})
export type Batch = Schema.Schema.Type<typeof Batch>

const Receipt = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("batch"), start: NonNegativeInt, end: NonNegativeInt }),
  Schema.Struct({ kind: Schema.Literal("page"), start: NonNegativeInt, end: NonNegativeInt }),
])

export class BudgetError extends Schema.TaggedErrorClass<BudgetError>()("InstructionBudgetError", {
  message: Schema.String,
}) {}

const DEFAULT_MAX_BYTES = 16 * 1024
const DEFAULT_MAX_REFERENCES = 8

function validPage(page: Page) {
  return (
    page.offset <= page.nextOffset &&
    page.nextOffset <= page.totalLength &&
    page.nextOffset - page.offset === page.text.length &&
    (page.totalLength !== 0 || (page.offset === 0 && page.nextOffset === 0 && page.text === ""))
  )
}

function completePages(pages: Page[]) {
  const groups = new Map<string, Page[]>()
  for (const page of pages) {
    if (!validPage(page)) continue
    const key = JSON.stringify([page.filepath, page.contentHash, page.totalLength])
    const items = groups.get(key) ?? []
    items.push(page)
    groups.set(key, items)
  }

  const result = new Set<string>()
  for (const items of groups.values()) {
    items.sort((a, b) => a.offset - b.offset || a.nextOffset - b.nextOffset)
    if (items[0]?.offset !== 0) continue
    let text = items[0].text
    let valid = true
    for (const page of items.slice(1)) {
      if (page.offset > text.length) {
        valid = false
        break
      }
      const overlap = Math.min(text.length, page.nextOffset) - page.offset
      if (overlap < 0 || text.slice(page.offset, page.offset + overlap) !== page.text.slice(0, overlap)) {
        valid = false
        break
      }
      if (page.nextOffset > text.length) text += page.text.slice(overlap)
    }
    const first = items[0]
    if (valid && text.length === first.totalLength && TextPage.hash(text) === first.contentHash)
      result.add(first.filepath)
  }
  return result
}

function extract(messages: SessionV1.WithParts[]) {
  const paths = new Set<string>()
  const pages: Page[] = []
  for (const msg of messages) {
    // Match MessageV2's model projection: user tool parts and omitted errors are not delivered.
    if (msg.info.role !== "assistant") continue
    if (
      msg.info.error &&
      !(
        SessionV1.AbortedError.isInstance(msg.info.error) &&
        msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
      )
    )
      continue
    for (const part of msg.parts) {
      if (part.type === "tool" && part.tool === "read" && part.state.status === "completed") {
        if (part.state.time.compacted !== undefined) continue
        const metadata = part.state.metadata
        if (Object.hasOwn(metadata, "receipt")) {
          const receipt = Schema.decodeUnknownOption(Receipt)(metadata.receipt)
          if (receipt._tag !== "Some") continue
          const { start, end } = receipt.value
          if (start > end || end > part.state.output.length) continue
          const parsed = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)(part.state.output.slice(start, end))
          if (parsed._tag !== "Some") continue
          if (receipt.value.kind === "page") {
            const page = Schema.decodeUnknownOption(Page)(parsed.value)
            if (page._tag === "Some") pages.push(page.value)
            continue
          }
          const batch = Schema.decodeUnknownOption(Batch)(parsed.value)
          if (batch._tag === "Some") pages.push(...batch.value.instructions)
          continue
        }
        const loaded = part.state.metadata?.loaded
        if (!loaded || !Array.isArray(loaded)) continue
        for (const p of loaded) {
          if (typeof p === "string") paths.add(p)
        }
      }
    }
  }
  for (const filepath of completePages(pages)) paths.add(filepath)
  return paths
}

export interface Interface {
  readonly clear: (messageID: MessageID) => Effect.Effect<void>
  readonly systemPaths: () => Effect.Effect<Set<string>, FSUtil.Error | InstructionSource.Error>
  readonly system: () => Effect.Effect<string[], InstructionSource.Error>
  readonly find: (dir: string) => Effect.Effect<string | undefined, FSUtil.Error>
  readonly isDocument: (filepath: string) => Effect.Effect<boolean, FSUtil.Error>
  readonly prepare: (
    messages: SessionV1.WithParts[],
    filepath: string,
    authorize: (filepath: string, canonicalFilepath: string) => Effect.Effect<void>,
    options?: { maxBytes?: number; maxReferences?: number },
  ) => Effect.Effect<
    { output: string; loaded: string[]; pending: boolean; hasMore: boolean },
    FSUtil.Error | BudgetError | InstructionSource.Error
  >
  readonly resolve: (
    messages: SessionV1.WithParts[],
    filepath: string,
    messageID: MessageID,
    authorize?: (filepath: string, canonicalFilepath: string) => Effect.Effect<void>,
  ) => Effect.Effect<{ filepath: string; content: string }[], FSUtil.Error | InstructionSource.Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Instruction") {}

const layer: Layer.Layer<
  Service,
  never,
  | FSUtil.Service
  | Config.Service
  | Global.Service
  | HttpClient.HttpClient
  | RuntimeFlags.Service
  | InstructionSource.Service
  | AmbientInstructions.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const cfg = yield* Config.Service
    const ambient = yield* AmbientInstructions.Service
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const source = yield* InstructionSource.Service
    const http = withTransientReadRetry(yield* HttpClient.HttpClient)
    const globalFiles = [
      path.join(global.config, "AGENTS.md"),
      ...(!flags.disableClaudeCodePrompt ? [path.join(global.home, ".claude", "CLAUDE.md")] : []),
    ]
    const instructionFiles = [
      "AGENTS.md",
      ...(!flags.disableClaudeCodePrompt ? ["CLAUDE.md"] : []),
      "CONTEXT.md", // deprecated
    ]

    const state = yield* InstanceState.make(
      Effect.fn("Instruction.state")(() =>
        Effect.succeed({
          // Track which instruction files have already been attached for a given assistant message.
          claims: new Map<MessageID, Set<string>>(),
          locks: KeyedMutex.makeUnsafe<MessageID>(),
        }),
      ),
    )

    const relative = Effect.fnUntraced(function* (instruction: string, maxResults: number) {
      const ctx = yield* InstanceState.context
      if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
        return yield* fs.globUp(instruction, ctx.directory, ctx.worktree, { maxResults })
      }
      return yield* fs.globUp(instruction, global.config, global.config, { maxResults })
    })

    const clear = Effect.fn("Instruction.clear")(function* (messageID: MessageID) {
      const s = yield* InstanceState.get(state)
      yield* s.locks.withLock(messageID)(Effect.sync(() => s.claims.delete(messageID)))
    })

    const paths = Effect.fn("Instruction.paths")(
      function* (configured: readonly string[]) {
        const ctx = yield* InstanceState.context
        const paths = new Set<string>()
        const maximum = source.limits.maxSources
        if (configured.length > maximum)
          return yield* new InstructionSource.Error({
            kind: "discovery",
            source: "configured ambient instructions",
            reason: "sources",
            maximum,
          })
        const urls = configured.filter((raw) => raw.startsWith("https://") || raw.startsWith("http://"))
        let candidates = urls.length
        const add = Effect.fnUntraced(function* (matches: readonly string[]) {
          // Count discovered candidates before deduplication so overlapping patterns cannot bypass discovery limits.
          candidates += matches.length
          if (candidates > maximum)
            return yield* new InstructionSource.Error({
              kind: "discovery",
              source: "ambient instructions",
              reason: "sources",
              maximum,
            })
          matches.forEach((item) => paths.add(path.resolve(item)))
        })

        for (const file of globalFiles) {
          const info = yield* fs
            .stat(file)
            .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
          if (info) {
            yield* add([file])
            break
          }
        }

        // The first project-level match wins so we don't stack AGENTS.md/CLAUDE.md from every ancestor.
        if (!Flag.OPENCODE_DISABLE_PROJECT_CONFIG) {
          for (const file of instructionFiles) {
            const matches = yield* fs.up({
              targets: [file],
              start: ctx.directory,
              stop: ctx.worktree,
              maxResults: maximum - candidates,
            })
            if (matches.length > 0) {
              yield* add(matches)
              break
            }
          }
        }

        if (configured.length) {
          for (const raw of configured) {
            if (raw.startsWith("https://") || raw.startsWith("http://")) continue
            const instruction = raw.startsWith("~/") ? path.join(global.home, raw.slice(2)) : raw
            const matches = yield* path.isAbsolute(instruction)
              ? fs.glob(path.basename(instruction), {
                  cwd: path.dirname(instruction),
                  absolute: true,
                  include: "file",
                  maxResults: maximum - candidates,
                })
              : relative(instruction, maximum - candidates)
            yield* add(matches)
          }
        }

        return paths
      },
      Effect.mapError((error) =>
        error instanceof FSUtil.DiscoveryLimitError
          ? new InstructionSource.Error({
              kind: "discovery",
              source: "ambient instructions",
              reason: "sources",
              maximum: source.limits.maxSources,
            })
          : error,
      ),
    )

    const systemPaths = Effect.fn("Instruction.systemPaths")(function* () {
      if (!ambient.current().automatic) return new Set<string>()
      return yield* paths((yield* cfg.get()).instructions ?? [])
    })

    const system = Effect.fn("Instruction.system")(
      function* () {
        if (!ambient.current().automatic) return []
        const config = yield* cfg.get()
        const files = yield* paths(config.instructions ?? [])
        const urls = (config.instructions ?? []).filter(
          (item) => item.startsWith("https://") || item.startsWith("http://"),
        )

        const contributions = yield* source.load(
          [
            ...Array.from(files, (path) => ({ kind: "file" as const, path })),
            ...urls.map((url) => ({ kind: "url" as const, url })),
          ],
          { http },
        )
        return contributions.flatMap((entry) => (entry.text ? [entry.rendered] : []))
      },
      Effect.mapError((error) =>
        error instanceof InstructionSource.Error
          ? error
          : new InstructionSource.Error({
              kind: "discovery",
              source: "ambient instruction discovery",
              reason: error instanceof FSUtil.DiscoveryLimitError ? "sources" : "unavailable",
              ...(error instanceof FSUtil.DiscoveryLimitError ? { maximum: source.limits.maxSources } : {}),
            }),
      ),
    )

    const find = Effect.fn("Instruction.find")(function* (dir: string) {
      for (const file of instructionFiles) {
        const filepath = path.resolve(path.join(dir, file))
        if (yield* fs.existsSafe(filepath)) return filepath
      }
      return undefined
    })

    const isDocument = Effect.fn("Instruction.isDocument")(function* (filepath: string) {
      const root = yield* fs.realPath(path.resolve(yield* InstanceState.directory))
      const stat = yield* fs
        .stat(filepath)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
      if (stat?.type !== "File") return false
      const canonical = yield* fs
        .realPath(filepath)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
      if (!canonical || !FSUtil.contains(root, canonical)) return false
      return instructionFiles.includes(path.basename(canonical))
    })

    const prepare = Effect.fn("Instruction.prepare")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      authorize: (filepath: string, canonicalFilepath: string) => Effect.Effect<void>,
      options: { maxBytes?: number; maxReferences?: number } = {},
    ) {
      if (!ambient.current().automatic) return { output: "", loaded: [], pending: false, hasMore: false }
      const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
      const maxReferences = options.maxReferences ?? DEFAULT_MAX_REFERENCES
      const root = yield* fs.realPath(path.resolve(yield* InstanceState.directory))
      const target = yield* fs.realPath(path.resolve(filepath))
      const system = new Set(yield* Effect.forEach(Array.from(yield* systemPaths()), identity))
      const already = new Set(yield* Effect.forEach(Array.from(extract(messages)), identity))
      const candidates: { filepath: string; canonical: string }[] = []
      const seenCandidates = new Set<string>()
      let current = path.dirname(target)

      // Keep the established nearest-ancestor-first precedence.
      while (FSUtil.contains(root, current) && current !== root) {
        const found = yield* find(current)
        const canonical = found
          ? yield* fs
              .realPath(found)
              .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
          : undefined
        if (
          found &&
          canonical &&
          FSUtil.contains(root, canonical) &&
          canonical !== target &&
          !system.has(canonical) &&
          !already.has(canonical) &&
          !seenCandidates.has(canonical)
        ) {
          seenCandidates.add(canonical)
          candidates.push({ filepath: found, canonical })
        }
        current = path.dirname(current)
      }

      const selected = candidates.slice(0, maxReferences)
      const beyondReferenceLimit = candidates.length > selected.length
      const instructions: Page[] = []
      const pendingPaths: string[] = []
      let blocked = false
      let hasMore = beyondReferenceLimit
      const encoded = (hasMore: boolean, nextInstructions = instructions, nextPending = pendingPaths) =>
        JSON.stringify({
          instructions: nextInstructions,
          pending: nextPending,
          hasMore,
        } satisfies Batch)
      const fits = (value: string) => new TextEncoder().encode(value).length <= maxBytes

      for (let index = 0; index < selected.length; index++) {
        const candidate = selected[index]
        const stat = yield* fs
          .stat(candidate.canonical)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
        if (stat?.type !== "File") continue
        yield* authorize(candidate.filepath, candidate.canonical)

        // This conservative input cap avoids reading arbitrarily large instruction bodies.
        // Explicit, verified pages in selected context are excluded above and remain supported.
        if (stat.size > maxBytes) {
          return yield* new BudgetError({
            message: `Automatic instruction delivery has a ${maxBytes}-byte input limit: ${candidate.canonical}. Reduce the document or explicitly read it with textPage and enough context. No automatic paging is attempted.`,
          })
        }

        const remainingBytes = maxBytes - new TextEncoder().encode(encoded(hasMore)).length
        if (blocked || (instructions.length > 0 && stat.size > remainingBytes)) {
          const nextPending = [...pendingPaths, candidate.canonical]
          const moreAfter = beyondReferenceLimit || index + 1 < selected.length
          const value = encoded(moreAfter, instructions, nextPending)
          if (fits(value)) {
            pendingPaths.push(candidate.canonical)
            hasMore = moreAfter
          } else {
            hasMore = true
            if (instructions.length === 0 && pendingPaths.length === 0) {
              return yield* Effect.fail(
                new BudgetError({ message: "Instruction references exceed the available output budget" }),
              )
            }
          }
          blocked = true
          continue
        }

        const bytes = yield* BoundedFile.read(fs, candidate.canonical, maxBytes).pipe(
          Effect.mapError((error) => {
            if (error instanceof BoundedFile.LimitError)
              return new BudgetError({
                message: `Automatic instruction delivery has a ${maxBytes}-byte input limit: ${candidate.canonical}. Reduce the document or explicitly read it with textPage and enough context. No automatic paging is attempted.`,
              })
            if (error instanceof BoundedFile.SourceError)
              return new FSUtil.FileSystemError({ method: "read instruction", cause: error })
            return error
          }),
        )
        const text = new TextDecoder("utf8", { ignoreBOM: true }).decode(bytes)
        const page: Page = {
          filepath: candidate.canonical,
          contentHash: TextPage.hash(text),
          offset: 0,
          nextOffset: text.length,
          totalLength: text.length,
          text,
        }
        if (!fits(encoded(false, [page], []))) {
          return yield* new BudgetError({
            message: `Automatic instruction delivery cannot fit this document in a ${maxBytes}-byte JSON envelope: ${candidate.canonical}. Reduce the document or explicitly read it with textPage and enough context. No automatic paging is attempted.`,
          })
        }
        const nextInstructions = [...instructions, page]
        const moreAfter = beyondReferenceLimit || index + 1 < selected.length
        const value = encoded(moreAfter, nextInstructions)
        if (fits(value)) {
          instructions.push(page)
          hasMore = moreAfter
          continue
        }

        const nextPending = [...pendingPaths, candidate.canonical]
        const pendingValue = encoded(true, instructions, nextPending)
        if (!fits(pendingValue)) {
          if (instructions.length === 0 && pendingPaths.length === 0) {
            return yield* Effect.fail(
              new BudgetError({ message: "Instruction references exceed the available output budget" }),
            )
          }
          hasMore = true
        } else {
          pendingPaths.push(candidate.canonical)
          hasMore = true
        }
        blocked = true
      }

      const output = encoded(hasMore)
      if (!fits(output)) {
        return yield* Effect.fail(
          new BudgetError({ message: "Instruction references exceed the available output budget" }),
        )
      }
      return {
        output,
        loaded: instructions.map((item) => item.filepath),
        pending: pendingPaths.length > 0 || hasMore,
        hasMore,
      }
    })

    const resolve = Effect.fn("Instruction.resolve")(function* (
      messages: SessionV1.WithParts[],
      filepath: string,
      messageID: MessageID,
      authorize?: (filepath: string, canonicalFilepath: string) => Effect.Effect<void>,
    ) {
      if (!ambient.current().automatic) return []
      const s = yield* InstanceState.get(state)
      return yield* s.locks.withLock(messageID)(
        Effect.gen(function* () {
          const sysPaths = yield* systemPaths()
          const sys = new Set(yield* Effect.forEach(Array.from(sysPaths), identity))
          const already = new Set(yield* Effect.forEach(Array.from(extract(messages)), identity))
          const pending = new Set<string>()
          const root = yield* fs.realPath(path.resolve(yield* InstanceState.directory))
          const target = yield* fs.realPath(path.resolve(filepath))
          let current = path.dirname(target)

          // Walk upward from the file being read and attach nearby instruction files once per message.
          while (FSUtil.contains(root, current) && current !== root) {
            const found = yield* find(current)
            const canonical = found
              ? yield* fs
                  .realPath(found)
                  .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
              : undefined
            if (
              !found ||
              !canonical ||
              !FSUtil.contains(root, canonical) ||
              canonical === target ||
              sys.has(canonical) ||
              already.has(canonical) ||
              s.claims.get(messageID)?.has(canonical) ||
              pending.has(canonical)
            ) {
              current = path.dirname(current)
              continue
            }

            if (pending.size >= source.limits.maxSources)
              return yield* new InstructionSource.Error({
                kind: "discovery",
                source: canonical,
                reason: "sources",
                maximum: source.limits.maxSources,
              })
            if (authorize) yield* authorize(found, canonical)
            pending.add(canonical)

            current = path.dirname(current)
          }

          const contributions = yield* source.load(
            Array.from(pending, (path) => ({ kind: "file" as const, path })),
            { http },
          )
          const results = contributions.flatMap((entry) =>
            entry.text ? [{ filepath: entry.source, content: entry.rendered }] : [],
          )
          if (results.length > 0) {
            let set = s.claims.get(messageID)
            if (!set) {
              set = new Set()
              s.claims.set(messageID, set)
            }
            for (const item of results) set.add(item.filepath)
          }

          return results
        }),
      )
    })

    const identity = Effect.fnUntraced(function* (filepath: string) {
      const absolute = path.resolve(filepath)
      return yield* fs
        .realPath(absolute)
        .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(absolute)))
    })

    return Service.of({ clear, systemPaths, system, find, isDocument, prepare, resolve })
  }),
)

export function loaded(messages: SessionV1.WithParts[]) {
  return extract(messages)
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Config.node,
    FSUtil.node,
    Global.node,
    RuntimeFlags.node,
    httpClient,
    InstructionSource.node,
    AmbientInstructions.node,
  ],
})

export * as Instruction from "./instruction"
