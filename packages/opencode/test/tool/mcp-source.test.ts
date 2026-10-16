import { ToolSource } from "@opencode-ai/core/harness/tool-source"
import { Effect, Layer } from "effect"
import { describe, expect, test } from "bun:test"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import { MCP } from "@/mcp"
import { McpTool } from "@/tool/mcp"
import { Tool } from "@/tool/tool"
import { Truncate } from "@/tool/truncate"
import { MessageID, SessionID } from "@/session/schema"

const guidance = "Use “lookup” before mutate; café 😀 & <raw>. "

function harness(input: { instructions?: string }) {
  let connects = 0
  let disconnects = 0
  let instructionReads = 0
  let status: MCP.Status = { status: "connected" }
  const layer = Layer.mergeAll(
    Layer.mock(Config.Service, {
      get: () => Effect.succeed({ mcp: { guide: { type: "local" as const, command: ["fixture"] } } }),
    }),
    Layer.mock(Agent.Service, {
      get: () => Effect.succeed({ name: "build", mode: "primary" as const, permission: [], options: {} }),
    }),
    Layer.mock(Truncate.Service, {
      output: (content: string) => Effect.succeed({ content, truncated: false as const }),
    }),
    Layer.mock(MCP.Service, {
      status: () => Effect.succeed({ guide: status }),
      instructions: () =>
        Effect.sync(() => {
          instructionReads++
          return input.instructions === undefined
            ? []
            : [{ name: "guide", instructions: input.instructions, tools: [] }]
        }),
      connect: () =>
        Effect.sync(() => {
          connects++
          status = { status: "connected" }
        }),
      disconnect: () =>
        Effect.sync(() => {
          disconnects++
          status = { status: "disabled" }
        }),
    }),
  )
  return { layer, counts: () => ({ connects, disconnects, instructionReads }) }
}

function context(): Tool.Context {
  return {
    sessionID: SessionID.make("ses_mcp_source"),
    messageID: MessageID.make("msg_mcp_source"),
    agent: "build",
    abort: new AbortController().signal,
    callID: "call_mcp_source",
    messages: [],
    metadata: () => Effect.void,
    ask: () => Effect.void,
  }
}

async function toolFor(input: { instructions?: string }) {
  const fixture = harness(input)
  const tool = await Effect.runPromise(McpTool.pipe(Effect.flatMap(Tool.init), Effect.provide(fixture.layer)))
  return { tool, counts: fixture.counts }
}

describe("tool.mcp context source receipts", () => {
  test("marks only returned cached guidance and keeps the receipt out of rendered output", async () => {
    const { tool, counts } = await toolFor({ instructions: guidance })
    const ctx = context()
    const first = await Effect.runPromise(tool.execute({ operation: "instructions", server: "guide" }, ctx))
    const second = await Effect.runPromise(tool.execute({ operation: "instructions", server: "guide" }, ctx))

    expect(first.output).toBe(JSON.stringify({ server: "guide", instructions: guidance }))
    expect(second.output).toBe(first.output)
    expect(first.output).not.toContain("contextSource")
    expect(first.metadata.contextSource).toBeDefined()
    expect(ToolSource.inspect(first.output, first.metadata)).toMatchObject({
      state: "matched",
      kind: "mcp-guidance",
      origin: "guide",
      body: { type: "json-member", member: "instructions", bytes: Buffer.byteLength(guidance, "utf8") },
    })
    expect(ToolSource.inspect(`${first.output} `, first.metadata).state).toBe("changed")
    expect(counts()).toEqual({ connects: 0, disconnects: 0, instructionReads: 2 })
  })

  test("discovery, lifecycle operations, and missing guidance carry no source receipt", async () => {
    const { tool, counts } = await toolFor({})
    const ctx = context()
    const discovery = await Effect.runPromise(tool.execute({ operation: "servers" }, ctx))
    const missing = await Effect.runPromise(tool.execute({ operation: "instructions", server: "guide" }, ctx))
    const connected = await Effect.runPromise(tool.execute({ operation: "connect", server: "guide" }, ctx))
    const disconnected = await Effect.runPromise(tool.execute({ operation: "disconnect", server: "guide" }, ctx))

    for (const result of [discovery, missing, connected, disconnected]) {
      expect(result.metadata.contextSource).toBeUndefined()
      expect(ToolSource.inspect(result.output, result.metadata).state).toBe("missing")
      expect(result.output).not.toContain("contextSource")
    }
    expect(counts()).toEqual({ connects: 1, disconnects: 1, instructionReads: 1 })
  })
})
