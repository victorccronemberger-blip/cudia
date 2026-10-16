export * as MCPContent from "./content"

import { Option, Schema } from "effect"
import type { Tool } from "../tool/tool"

const Content = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literals(["image", "audio"]), data: Schema.String, mimeType: Schema.String }),
  Schema.Struct({ type: Schema.Literal("resource_link"), uri: Schema.String, name: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("resource"),
    resource: Schema.Union([
      Schema.Struct({ uri: Schema.String, text: Schema.String }),
      Schema.Struct({ uri: Schema.String, blob: Schema.String, mimeType: Schema.String.pipe(Schema.optional) }),
    ]),
  }),
])

/** Projection only: the complete MCP result remains the canonical structured output. */
export function render(result: Readonly<Record<string, unknown>>): ReadonlyArray<Tool.Content> {
  const parts: Tool.Content[] = result.isError === true ? [{ type: "text", text: "MCP tool reported an error." }] : []
  for (const value of Array.isArray(result.content) ? result.content : []) {
    const decoded = Schema.decodeUnknownOption(Content)(value)
    if (Option.isNone(decoded)) {
      parts.push({ type: "text", text: JSON.stringify(value) })
      continue
    }
    const part = decoded.value
    if (part.type === "text") parts.push({ type: "text", text: part.text })
    if (part.type === "image" || part.type === "audio")
      parts.push({ type: "file", data: part.data, mime: part.mimeType })
    if (part.type === "resource_link") parts.push({ type: "text", text: `${part.name}: ${part.uri}` })
    if (part.type === "resource") {
      if ("text" in part.resource) parts.push({ type: "text", text: `${part.resource.uri}\n${part.resource.text}` })
      else
        parts.push({
          type: "file",
          data: part.resource.blob,
          mime: part.resource.mimeType ?? "application/octet-stream",
        })
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined)
    parts.push({ type: "text", text: JSON.stringify(result.structuredContent) })
  return parts
}
