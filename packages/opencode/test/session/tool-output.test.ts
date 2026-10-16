import { describe, expect, test } from "bun:test"
import { ToolOutput } from "../../src/session/tool-output"
import { MessageID, PartID } from "../../src/session/schema"

describe("recorded tool output projection", () => {
  test("preserves a Unicode boundary and points to the retained record", () => {
    const part = {
      messageID: MessageID.make("msg_history"),
      id: PartID.make("prt_history"),
      state: {
        status: "completed" as const,
        input: {},
        output: "A😀B",
        title: "result",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }
    const snapshot = structuredClone(part)
    const result = ToolOutput.project(part, 2)
    expect(result.startsWith("A\n[")).toBe(true)
    expect(result).not.toContain("\uD83D")
    expect(result).toContain('tool_result({"messageID":"msg_history","partID":"prt_history"})')
    expect(part).toEqual(snapshot)
    expect(ToolOutput.project(part)).toBe("A😀B")
  })

  test("retains recovery identifiers when omitted output is summarized again", () => {
    const part = {
      messageID: MessageID.make("msg_history"),
      id: PartID.make("prt_history"),
      state: {
        status: "completed" as const,
        input: {},
        output: "private recorded text",
        title: "result",
        metadata: {},
        time: { start: 1, end: 2, compacted: 3 },
      },
    }
    const normal = ToolOutput.project(part)
    expect(ToolOutput.project(part, 2_000, "[Attached image/png: evidence.png]")).toBe(normal)
    expect(normal).toContain("msg_history")
    expect(normal).toContain("prt_history")
    expect(normal).toContain("attachments are excluded")
    expect(normal).not.toContain(part.state.output)
    expect(part.state.output).toBe("private recorded text")
  })
})
