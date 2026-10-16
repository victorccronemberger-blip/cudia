import { expect, test } from "bun:test"
import { MCPContent } from "../src/mcp/content"

test("MCP content preserves text, media and resource references for canonical projection", () => {
  const result = {
    content: [
      { type: "text", text: "observed result" },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      { type: "resource_link", uri: "file:///artifact", name: "Artifact" },
      { type: "resource", resource: { uri: "fixture://text", text: "evidence" } },
      { type: "resource", resource: { uri: "fixture://blob", blob: "YmxvYg==" } },
    ],
    structuredContent: { answer: 42 },
  }
  expect(MCPContent.render(result)).toEqual([
    { type: "text", text: "observed result" },
    { type: "file", data: "aW1hZ2U=", mime: "image/png" },
    { type: "text", text: "Artifact: file:///artifact" },
    { type: "text", text: "fixture://text\nevidence" },
    { type: "file", data: "YmxvYg==", mime: "application/octet-stream" },
  ])
  expect(result.structuredContent).toEqual({ answer: 42 })
})

test("MCP structured-only results are visible and remote error results are identified", () => {
  expect(MCPContent.render({ content: [], structuredContent: { answer: 42 } })).toEqual([
    { type: "text", text: '{"answer":42}' },
  ])
  expect(MCPContent.render({ isError: true, content: [{ type: "text", text: "remote failure" }] })).toEqual([
    { type: "text", text: "MCP tool reported an error." },
    { type: "text", text: "remote failure" },
  ])
})
