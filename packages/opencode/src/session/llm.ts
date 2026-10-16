import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { llmClient } from "@opencode-ai/core/effect/app-node-platform"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Provider } from "@/provider/provider"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Context, Effect, Layer } from "effect"
import * as Stream from "effect/Stream"
import { streamText, wrapLanguageModel, type ModelMessage, type Tool } from "ai"
import type { LLMEvent } from "@opencode-ai/llm"
import { LLMClient } from "@opencode-ai/llm/route"
import type { LLMClientService } from "@opencode-ai/llm/route"
import { GitLabWorkflowLanguageModel } from "gitlab-ai-provider"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { Auth } from "@/auth"
import { EffectBridge } from "@/effect/bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import * as Option from "effect/Option"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { LLMAISDK } from "./llm/ai-sdk"
import { LLMNativeRuntime } from "./llm/native-runtime"
import { LLMRequestPrep } from "./llm/request"
import { WorkflowSessions } from "./llm/workflow"
import { HarnessPolicy } from "@opencode-ai/core/harness/policy"
import { ContextAudit } from "@opencode-ai/core/harness/audit"
import { ContextTrace } from "@opencode-ai/core/harness/trace"
import type { HistoryProjection } from "./history-projection"

export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

export type StreamInput = {
  user: SessionV1.User
  sessionID: string
  parentSessionID?: string
  model: Provider.Model
  agent: Agent.Info
  permission?: PermissionV1.Ruleset
  system: string[]
  messages: ModelMessage[]
  small?: boolean
  tools: Record<string, Tool>
  retries?: number
  toolChoice?: "auto" | "required" | "none"
  contextTrace?: ContextTrace.Collector
  /** Observation only: callers identify the operation; never sent to providers. */
  purpose?: ContextAudit.Input["purpose"]
  compactionMessageID?: string
  historySnapshot?: ContextAudit.Input["historySnapshot"]
  historyProjection?: HistoryProjection.Collector
}

export type StreamRequest = StreamInput & {
  abort: AbortSignal
}

export interface Interface {
  readonly stream: (input: StreamInput) => Stream.Stream<LLMEvent, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LLM") {}

export const use = serviceUse(Service)

const live: Layer.Layer<
  Service,
  never,
  | Auth.Service
  | Config.Service
  | Provider.Service
  | Plugin.Service
  | WorkflowSessions.Service
  | LLMClientService
  | RuntimeFlags.Service
  | HarnessPolicy.Service
  | ContextAudit.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    const config = yield* Config.Service
    const provider = yield* Provider.Service
    const plugin = yield* Plugin.Service
    const workflows = yield* WorkflowSessions.Service
    const llmClient = yield* LLMClient.Service
    const flags = yield* RuntimeFlags.Service
    const policy = yield* HarnessPolicy.Service
    const audit = yield* ContextAudit.Service

    const run = Effect.fn("LLM.run")(function* (input: StreamRequest, controller: AbortController) {
      yield* Effect.logInfo("stream", {
        providerID: input.model.providerID,
        modelID: input.model.id,
        "session.id": input.sessionID,
        small: (input.small ?? false).toString(),
        agent: input.agent.name,
        mode: input.agent.mode,
      })

      const [template, cfg, item, info] = yield* Effect.all(
        [
          provider.getLanguage(input.model),
          config.get(),
          provider.getProvider(input.model.providerID),
          auth.get(input.model.providerID),
        ],
        { concurrency: "unbounded" },
      )

      const workflow =
        template instanceof GitLabWorkflowLanguageModel
          ? yield* workflows.acquire({ sessionID: input.sessionID, model: input.model, template, controller })
          : undefined
      const language = workflow?.model ?? template
      const isWorkflow = !!workflow
      const contextTrace =
        audit.enabled && !input.small && !isWorkflow ? (input.contextTrace ?? ContextTrace.create()) : undefined
      const prepared = yield* LLMRequestPrep.prepare({
        ...input,
        provider: item,
        auth: info,
        plugin,
        flags,
        isWorkflow,
        contextMode: policy.contextMode,
        contextTrace,
      })

      // Wire up toolExecutor for DWS workflow models so that tool calls
      // from the workflow service are executed via opencode's tool system
      // and results sent back over the WebSocket.
      const bridge = yield* EffectBridge.make()
      if (workflow) {
        const workflowModel = workflow.model
        workflowModel.sessionID = input.sessionID
        workflowModel.systemPrompt = prepared.system.join("\n")
        workflowModel.toolExecutor = async (toolName, argsJson, requestID) => {
          if (!workflow.current()) throw new DOMException("Workflow call is no longer active", "AbortError")
          const t = prepared.tools[toolName]
          if (!t || !t.execute) return { result: "", error: `Unknown tool: ${toolName}` }
          try {
            const result = await t.execute(JSON.parse(argsJson), {
              toolCallId: requestID,
              messages: input.messages,
              abortSignal: input.abort,
            })
            if (!workflow.current()) throw new DOMException("Workflow call is no longer active", "AbortError")
            const output = typeof result === "string" ? result : (result?.output ?? JSON.stringify(result))
            return {
              result: output,
              metadata: typeof result === "object" ? result?.metadata : undefined,
              title: typeof result === "object" ? result?.title : undefined,
            }
          } catch (e: unknown) {
            if (!workflow.current()) throw new DOMException("Workflow call is no longer active", "AbortError")
            return { result: "", error: e instanceof Error ? e.message : String(e) }
          }
        }
        workflowModel.sessionPreapprovedTools = Object.keys(prepared.tools)
        workflowModel.approvalHandler = async () => {
          if (!workflow.current()) throw new DOMException("Workflow call is no longer active", "AbortError")
          return { approved: true }
        }
      }

      const tracer = cfg.experimental?.openTelemetry
        ? Option.getOrUndefined(yield* Effect.serviceOption(OtelTracer.OtelTracer))
        : undefined
      const telemetryTracer = tracer
        ? new Proxy(tracer, {
            get(target, prop, receiver) {
              if (prop !== "startSpan") return Reflect.get(target, prop, receiver)
              return (...args: Parameters<typeof target.startSpan>) => {
                const span = target.startSpan(...args)
                span.setAttribute("session.id", input.sessionID)
                return span
              }
            },
          })
        : undefined

      // Runtime seam: native is an opt-in adapter over @opencode-ai/llm. It
      // either returns a ready LLMEvent stream or a concrete fallback reason.
      if (flags.experimentalNativeLlm) {
        const native = LLMNativeRuntime.stream({
          model: input.model,
          provider: item,
          auth: info,
          llmClient,
          messages: prepared.messages,
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          maxOutputTokens: prepared.params.maxOutputTokens,
          providerOptions: prepared.params.options,
          headers: prepared.headers,
          abort: input.abort,
          onRequest:
            audit.enabled && !input.small
              ? (request) =>
                  audit.record({
                    runtime: "v1-native",
                    ...(input.historySnapshot === undefined
                      ? {}
                      : {
                          historySnapshot: input.historyProjection?.capture(request.messages) ?? input.historySnapshot,
                        }),
                    ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
                    ...(input.purpose === "compaction" && input.compactionMessageID !== undefined
                      ? { compactionMessageID: input.compactionMessageID }
                      : {}),
                    sessionID: input.sessionID,
                    agent: input.agent.name,
                    model: { provider: request.model.provider, id: request.model.id },
                    instructions: [
                      ...request.system.map((part) => ({ source: "system", text: part.text })),
                      ...request.messages.flatMap((message) =>
                        message.role === "system"
                          ? message.content.flatMap((part) =>
                              part.type === "text" ? [{ source: "system-message", text: part.text }] : [],
                            )
                          : [],
                      ),
                    ],
                    messages: request.messages,
                    ...(input.purpose === "compaction"
                      ? {
                          messageSources: request.messages.flatMap((message, messageIndex) =>
                            message.role === "user"
                              ? message.content.flatMap((part, partIndex) =>
                                  part.type === "text"
                                    ? [
                                        {
                                          source: "compaction-prompt",
                                          role: message.role,
                                          messageIndex,
                                          partIndex,
                                          text: part.text,
                                        },
                                      ]
                                    : [],
                                )
                              : [],
                          ),
                        }
                      : {}),
                    tools: request.tools,
                    ...(contextTrace ? { trace: contextTrace.capture() } : {}),
                  })
              : undefined,
        })
        if (native.type === "supported") {
          yield* Effect.logInfo("llm runtime selected", {
            "llm.runtime": "native",
            "llm.provider": input.model.providerID,
            "llm.model": input.model.id,
          })
          return {
            type: "native" as const,
            stream: native.stream,
            workflow,
          }
        }
        yield* Effect.logInfo("llm runtime selected", {
          "llm.runtime": "ai-sdk",
          "llm.provider": input.model.providerID,
          "llm.model": input.model.id,
          "llm.native_unsupported_reason": native.reason,
        })
        yield* Effect.logInfo("native runtime unavailable; falling back to ai-sdk", {
          providerID: input.model.providerID,
          modelID: input.model.id,
          "session.id": input.sessionID,
          small: (input.small ?? false).toString(),
          agent: input.agent.name,
          mode: input.agent.mode,
          reason: native.reason,
        })
      }

      yield* Effect.logInfo("llm runtime selected", {
        "llm.runtime": "ai-sdk",
        "llm.provider": input.model.providerID,
        "llm.model": input.model.id,
      })
      // Default runtime path: AI SDK owns provider execution and tool dispatch;
      // LLMAISDK.toLLMEvents below normalizes fullStream parts for the processor.
      return {
        type: "ai-sdk" as const,
        workflow,
        result: streamText({
          onError(error) {
            bridge.fork(
              Effect.logError("stream error", {
                providerID: input.model.providerID,
                modelID: input.model.id,
                "session.id": input.sessionID,
                small: (input.small ?? false).toString(),
                agent: input.agent.name,
                mode: input.agent.mode,
                error,
              }),
            )
          },
          // Copilot returns the authoritative billed amount only in provider-specific response fields.
          includeRawChunks: input.model.providerID.includes("github-copilot"),
          async experimental_repairToolCall(failed) {
            const lower = failed.toolCall.toolName.toLowerCase()
            if (lower !== failed.toolCall.toolName && prepared.tools[lower]) {
              return {
                ...failed.toolCall,
                toolName: lower,
              }
            }
            return {
              ...failed.toolCall,
              input: JSON.stringify({
                tool: failed.toolCall.toolName,
                error: failed.error.message,
              }),
              toolName: "invalid",
            }
          },
          temperature: prepared.params.temperature,
          topP: prepared.params.topP,
          topK: prepared.params.topK,
          providerOptions: ProviderTransform.providerOptions(input.model, prepared.params.options),
          activeTools: Object.keys(prepared.tools).filter((x) => x !== "invalid"),
          tools: prepared.tools,
          toolChoice: input.toolChoice,
          maxOutputTokens: prepared.params.maxOutputTokens,
          abortSignal: input.abort,
          headers: prepared.headers,
          maxRetries: input.retries ?? 0,
          messages: prepared.messages,
          model: wrapLanguageModel({
            model: language,
            middleware: [
              {
                specificationVersion: "v3" as const,
                async transformParams(args) {
                  if (args.type === "stream") {
                    const finish = contextTrace?.start(
                      {
                        stage: "ProviderTransform.message",
                        projection: "normalized-model-messages",
                        source: { kind: "runtime", id: "provider-message-transform", ordinal: 0 },
                      },
                      () => args.params.prompt,
                    )
                    try {
                      // @ts-expect-error
                      args.params.prompt = ProviderTransform.message(
                        args.params.prompt,
                        input.model,
                        prepared.messageTransformOptions,
                      )
                      finish?.("success")
                    } catch (error) {
                      finish?.("failure")
                      throw error
                    }
                    if (audit.enabled && !input.small && !isWorkflow) {
                      await bridge.promise(
                        audit.record({
                          runtime: "v1-ai-sdk",
                          ...(input.historySnapshot === undefined
                            ? {}
                            : {
                                historySnapshot:
                                  input.historyProjection?.capture(args.params.prompt) ?? input.historySnapshot,
                              }),
                          ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
                          ...(input.purpose === "compaction" && input.compactionMessageID !== undefined
                            ? { compactionMessageID: input.compactionMessageID }
                            : {}),
                          sessionID: input.sessionID,
                          agent: input.agent.name,
                          model: { provider: input.model.providerID, id: input.model.api.id },
                          instructions: [
                            ...args.params.prompt.flatMap((message) =>
                              message.role === "system" ? [{ source: "system", text: message.content }] : [],
                            ),
                            ...Object.entries(args.params.providerOptions ?? {}).flatMap(([namespace, options]) =>
                              typeof options.instructions === "string"
                                ? [{ source: `provider-instructions:${namespace}`, text: options.instructions }]
                                : [],
                            ),
                          ],
                          messages: args.params.prompt,
                          ...(input.purpose === "compaction"
                            ? {
                                messageSources: args.params.prompt.flatMap((message, messageIndex) =>
                                  message.role === "user"
                                    ? message.content.flatMap((part, partIndex) =>
                                        part.type === "text"
                                          ? [
                                              {
                                                source: "compaction-prompt",
                                                role: message.role,
                                                messageIndex,
                                                partIndex,
                                                text: part.text,
                                              },
                                            ]
                                          : [],
                                      )
                                    : [],
                                ),
                              }
                            : {}),
                          tools: (args.params.tools ?? []).map((tool) => ({
                            name: tool.name,
                            ...(tool.type === "function"
                              ? { description: tool.description, inputSchema: tool.inputSchema }
                              : {}),
                          })),
                          ...(contextTrace ? { trace: contextTrace.capture() } : {}),
                        }),
                      )
                    }
                  }
                  return args.params
                },
              },
            ],
          }),
          experimental_telemetry: {
            isEnabled: cfg.experimental?.openTelemetry,
            functionId: "session.llm",
            tracer: telemetryTracer,
            metadata: {
              userId: cfg.username ?? "unknown",
              sessionId: input.sessionID,
            },
          },
        }),
      }
    })

    const stream: Interface["stream"] = (input) =>
      Stream.scoped(
        Stream.unwrap(
          Effect.gen(function* () {
            const ctrl = yield* Effect.acquireRelease(
              Effect.sync(() => new AbortController()),
              (ctrl) => Effect.sync(() => ctrl.abort()),
            )

            const result = yield* run({ ...input, abort: ctrl.signal }, ctrl)

            // Adapter seam: both runtimes expose the same LLMEvent stream. Native
            // already returns one; AI SDK streams are converted here.
            const state = LLMAISDK.adapterState()
            const output =
              result.type === "native"
                ? result.stream
                : Stream.fromAsyncIterable(result.result.fullStream, (e) =>
                    e instanceof Error ? e : new Error(String(e)),
                  ).pipe(
                    Stream.mapEffect((event) => LLMAISDK.toLLMEvents(state, event)),
                    Stream.flatMap((events) => Stream.fromIterable(events)),
                  )
            if (!result.workflow) return output
            const workflow = result.workflow
            const aborted = Effect.callback<never>((resume) => {
              const abort = () => resume(Effect.interrupt)
              if (ctrl.signal.aborted) {
                abort()
                return
              }
              ctrl.signal.addEventListener("abort", abort, { once: true })
              return Effect.sync(() => ctrl.signal.removeEventListener("abort", abort))
            })
            return output.pipe(Stream.onEnd(Effect.sync(workflow.complete)), Stream.interruptWhen(aborted))
          }),
        ),
      )

    return Service.of({ stream })
  }),
)

export const hasToolCalls = LLMRequestPrep.hasToolCalls

export const node = LayerNode.make({
  service: Service,
  layer: live,
  deps: [
    Auth.node,
    Config.node,
    Provider.node,
    Plugin.node,
    WorkflowSessions.node,
    llmClient,
    RuntimeFlags.node,
    HarnessPolicy.node,
    ContextAudit.node,
  ],
})

export * as LLM from "./llm"
