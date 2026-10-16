import type { JsonSchema, LLMRequest, ProviderMetadata, ToolContent } from "@opencode-ai/llm"
import { LLM, Media, Message, SystemPart, ToolCallPart, ToolDefinition, ToolResultPart } from "@opencode-ai/llm"
import {
  AmazonBedrock,
  Anthropic,
  Azure,
  Google,
  OpenAI,
  OpenAICompatible,
  OpenRouter,
} from "@opencode-ai/llm/providers"
import type { ModelMessage } from "ai"
import type { Provider } from "@/provider/provider"
import { isRecord } from "@/util/record"
import type { HistoryProjection } from "../history-projection"

type ToolInput = {
  readonly description?: string
  readonly inputSchema?: unknown
}

export type RequestInput = {
  readonly model: Provider.Model
  readonly apiKey?: string
  readonly baseURL?: string
  readonly system?: readonly string[]
  readonly messages: readonly ModelMessage[]
  readonly tools?: Record<string, ToolInput>
  readonly toolChoice?: "auto" | "required" | "none"
  readonly temperature?: number
  readonly topP?: number
  readonly topK?: number
  readonly maxOutputTokens?: number
  readonly providerOptions?: LLMRequest["providerOptions"]
  readonly headers?: Record<string, string>
  readonly historyProjection?: HistoryProjection.Native
}

const providerMetadata = (value: unknown): ProviderMetadata | undefined => {
  if (!isRecord(value)) return undefined
  const result = Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] => isRecord(entry[1])),
  )
  return Object.keys(result).length === 0 ? undefined : result
}

// Stored AI SDK parts historically kept provider-owned continuation metadata in
// `providerOptions`; native parts now use `providerMetadata` directly.
const partProviderMetadata = (part: Record<string, unknown>) =>
  providerMetadata(part.providerMetadata) ?? providerMetadata(part.providerOptions)

const textPart = (part: Record<string, unknown>) => ({
  type: "text" as const,
  text: typeof part.text === "string" ? part.text : "",
  providerMetadata: partProviderMetadata(part),
})

const mediaPart = (part: Record<string, unknown>) => {
  if (typeof part.data !== "string" && !(part.data instanceof Uint8Array))
    throw new Error("Native LLM request adapter only supports file parts with string or Uint8Array data")
  return {
    type: "media" as const,
    mediaType: typeof part.mediaType === "string" ? part.mediaType : "application/octet-stream",
    data: part.data,
    filename: typeof part.filename === "string" ? part.filename : undefined,
  }
}

const textContentKeys = new Set(["type", "text", "providerOptions"])
const imageContentKeys = new Set(["type", "data", "mediaType", "providerOptions"])
const fileContentKeys = new Set([...imageContentKeys, "filename"])
const imageMimes = new Set<string>(Media.IMAGE_MIMES)

/** Preserve unsupported arrays whole; partial lowering would discard tool output. */
function toolContent(value: unknown): ToolContent[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  const result: ToolContent[] = []
  for (const item of value) {
    if (!isRecord(item) || item.providerOptions !== undefined) return undefined
    const keys = item.type === "text" ? textContentKeys : item.type === "file-data" ? fileContentKeys : imageContentKeys
    if (Object.keys(item).some((key) => !keys.has(key))) return undefined
    if (item.type === "text") {
      if (typeof item.text !== "string") return undefined
      result.push({ type: "text", text: item.text })
      continue
    }
    if (item.type !== "media" && item.type !== "image-data" && item.type !== "file-data") return undefined
    if (
      typeof item.data !== "string" ||
      typeof item.mediaType !== "string" ||
      (item.filename !== undefined && typeof item.filename !== "string")
    )
      return undefined
    if (Media.inspect({ mediaType: item.mediaType, data: item.data }, imageMimes).status !== "valid") return undefined
    result.push({
      type: "file",
      uri: item.data.startsWith("data:") ? item.data : `data:${item.mediaType};base64,${item.data}`,
      mime: item.mediaType,
      ...(typeof item.filename === "string" ? { name: item.filename } : {}),
    })
  }
  return result
}

const toolResult = (part: Record<string, unknown>, projection?: HistoryProjection.Native) => {
  const output = isRecord(part.output) ? part.output : { type: "json", value: part.output }
  const projected = output.type === "content" ? toolContent(output.value) : undefined
  const type = projected ? "content" : output.type === "text" ? "text" : output.type === "error-text" ? "error" : "json"
  const result = ToolResultPart.make({
    id: typeof part.toolCallId === "string" ? part.toolCallId : "",
    name: typeof part.toolName === "string" ? part.toolName : "",
    result: projected ?? ("value" in output ? output.value : output),
    resultType: type,
    providerExecuted: typeof part.providerExecuted === "boolean" ? part.providerExecuted : undefined,
    providerMetadata: partProviderMetadata(part),
  })
  projection?.nativeResult(part.output, result)
  return result
}

const contentPart = (part: unknown, projection?: HistoryProjection.Native) => {
  if (!isRecord(part)) throw new Error("Native LLM request adapter only supports object content parts")
  if (part.type === "text") return textPart(part)
  if (part.type === "file") return mediaPart(part)
  if (part.type === "reasoning")
    return {
      type: "reasoning" as const,
      text: typeof part.text === "string" ? part.text : "",
      providerMetadata: partProviderMetadata(part),
    }
  if (part.type === "tool-call")
    return ToolCallPart.make({
      id: typeof part.toolCallId === "string" ? part.toolCallId : "",
      name: typeof part.toolName === "string" ? part.toolName : "",
      input: part.input,
      providerExecuted: typeof part.providerExecuted === "boolean" ? part.providerExecuted : undefined,
      providerMetadata: partProviderMetadata(part),
    })
  if (part.type === "tool-result") return toolResult(part, projection)
  throw new Error(`Native LLM request adapter does not support ${String(part.type)} content parts`)
}

const content = (value: ModelMessage["content"], projection?: HistoryProjection.Native) =>
  typeof value === "string"
    ? [{ type: "text" as const, text: value }]
    : value.map((part) => contentPart(part, projection))

const messages = (input: readonly ModelMessage[], projection?: HistoryProjection.Native) => {
  const system = input.flatMap((message) => (message.role === "system" ? [SystemPart.make(message.content)] : []))
  const messages = input.flatMap((message) => {
    if (message.role === "system") return []
    const original = {
      role: message.role,
      content: content(message.content, projection),
      native: isRecord(message.providerOptions) ? { providerOptions: message.providerOptions } : undefined,
    }
    const converted = Message.make(original)
    projection?.nativeCopied([original], [converted])
    return [converted]
  })
  return { system, messages }
}

const schema = (value: unknown): JsonSchema => {
  if (!isRecord(value)) return { type: "object", properties: {} }
  if (isRecord(value.jsonSchema)) return value.jsonSchema
  return value
}

const tools = (input: Record<string, ToolInput> | undefined): ToolDefinition[] =>
  Object.entries(input ?? {}).map(([name, item]) =>
    ToolDefinition.make({
      name,
      description: item.description ?? "",
      inputSchema: schema(item.inputSchema),
    }),
  )

const generation = (input: RequestInput) => {
  const result = {
    temperature: input.temperature,
    topP: input.topP,
    topK: input.topK,
    maxTokens: input.maxOutputTokens,
  }
  return Object.values(result).some((value) => value !== undefined) ? result : undefined
}

const baseURL = (input: Provider.Model | RequestInput) =>
  "model" in input ? (input.baseURL ?? (input.model.api.url || undefined)) : input.api.url || undefined

const requireBaseURL = (model: Provider.Model, url: string | undefined) => {
  if (url) return url
  throw new Error(`Native LLM request adapter requires a base URL for ${model.providerID}/${model.id}`)
}

export const model = (input: Provider.Model | RequestInput, headers?: Record<string, string>) => {
  const model = "model" in input ? input.model : input
  const url = baseURL(input)
  const options = {
    ...("model" in input && input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(url ? { baseURL: url } : {}),
    headers: Object.keys({ ...model.headers, ...headers }).length === 0 ? undefined : { ...model.headers, ...headers },
    limits: {
      context: model.limit.context,
      output: model.limit.output,
    },
  }
  if (model.api.npm === "@ai-sdk/openai") return OpenAI.configure(options).responses(model.api.id)
  if (model.api.npm === "@ai-sdk/azure")
    return Azure.configure({ ...options, baseURL: requireBaseURL(model, url) }).responses(model.api.id)
  if (model.api.npm === "@ai-sdk/anthropic") return Anthropic.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/google") return Google.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/amazon-bedrock") return AmazonBedrock.configure(options).model(model.api.id)
  if (model.api.npm === "@ai-sdk/openai-compatible")
    return OpenAICompatible.configure({
      ...options,
      provider: String(model.providerID),
      baseURL: requireBaseURL(model, url),
    }).model(model.api.id)
  if (model.api.npm === "@openrouter/ai-sdk-provider") return OpenRouter.configure(options).model(model.api.id)
  throw new Error(`Native LLM request adapter does not support provider package ${model.api.npm}`)
}

export const request = (input: RequestInput) => {
  const converted = messages(input.messages, input.historyProjection)
  // This is the only native adapter boundary that should construct canonical
  // @opencode-ai/llm request objects from opencode's session/AI SDK-shaped data.
  const request = LLM.request({
    model: model(input, input.headers),
    system: [...(input.system ?? []).map(SystemPart.make), ...converted.system],
    messages: converted.messages,
    tools: tools(input.tools),
    toolChoice: input.toolChoice,
    generation: generation(input),
    providerOptions: input.providerOptions,
  })
  input.historyProjection?.nativeCopied(converted.messages, request.messages)
  return request
}

export * as LLMNative from "./native-request"
