import { expect } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { ContextAudit } from "@opencode-ai/core/harness/audit"
import { ContextHistory } from "@opencode-ai/core/harness/audit-history"
import { ToolSource } from "@opencode-ai/core/harness/tool-source"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "optional history leaves real provider messages and tool definitions unchanged even when persistence fails",
  ({ home, llm, opencode }) =>
    Effect.gen(function* () {
      const env = { CUDIA_CONTEXT_MODE: "lean", CUDIA_CONTEXT_AUDIT: "summary", CUDIA_CONTEXT_AUDIT_HISTORY: "0" }
      yield* llm.text("HISTORY_WIRE_OK")
      const baseline = yield* opencode.run("HISTORY_WIRE_INPUT", { agent: "build", env })
      opencode.expectExit(baseline, 0, "baseline provider request")
      const before = (yield* llm.inputs).at(-1)!
      expect(before).toBeDefined()
      yield* llm.text("HISTORY_WIRE_OK")
      const enabled = yield* opencode.run("HISTORY_WIRE_INPUT", {
        agent: "build",
        env: { ...env, CUDIA_CONTEXT_AUDIT_HISTORY: "1" },
      })
      opencode.expectExit(enabled, 0, "history-enabled provider request")
      const after = (yield* llm.inputs).at(-1)!
      expect(after.messages).toEqual(before.messages)
      expect(after.tools).toEqual(before.tools)
      expect(enabled.stdout).toBe(baseline.stdout)
      const history = yield* ContextHistory.read(path.join(home, ".local/state/opencode", ContextHistory.FILE))
      expect(history?.retained.count).toBeGreaterThan(0)
      const unavailableState = path.join(home, "unavailable-history-state")
      yield* Effect.promise(() =>
        fs.mkdir(path.join(unavailableState, "opencode", ContextHistory.FILE), { recursive: true }),
      )
      yield* llm.text("HISTORY_WIRE_OK")
      const unavailable = yield* opencode.run("HISTORY_WIRE_INPUT", {
        agent: "build",
        env: { ...env, XDG_STATE_HOME: unavailableState, CUDIA_CONTEXT_AUDIT_HISTORY: "1" },
      })
      opencode.expectExit(unavailable, 0, "history-unavailable provider request")
      const recovered = (yield* llm.inputs).at(-1)!
      expect(recovered.messages).toEqual(before.messages)
      expect(recovered.tools).toEqual(before.tools)
      expect(unavailable.stdout).toBe(baseline.stdout)
    }),
  60_000,
)

cliIt.live(
  "debug context reads bounded historical metadata by session and cursor without exposing captured text",
  ({ home, opencode }) =>
    Effect.gen(function* () {
      const file = path.join(home, ".local/state/opencode", ContextHistory.FILE)
      const input: ContextAudit.Input = {
        runtime: "v2",
        purpose: "compaction",
        compactionMessageID: "msg_history_checkpoint",
        sessionID: "ses_history_first",
        agent: "compaction",
        model: { provider: "fixture", id: "fixture" },
        instructions: [{ source: "agent", text: "SYNTHETIC_PRIVATE_HISTORY_INSTRUCTION" }],
        messages: [{ role: "user" }],
        tools: [],
      }
      const first = yield* ContextHistory.append(
        file,
        ContextAudit.report(input, { contextMode: "lean", auditMode: "content" }, "now"),
      )
      const second = yield* ContextHistory.append(
        file,
        ContextAudit.report(
          {
            ...input,
            sessionID: "ses_history_second",
            purpose: "main",
            compactionMessageID: undefined,
            messageSources: [
              {
                source: "conversation-checkpoint",
                role: "user",
                messageIndex: 0,
                partIndex: 0,
                messageID: "msg_history_checkpoint",
                text: "SYNTHETIC_PRIVATE_HISTORY_CHECKPOINT",
              },
            ],
          },
          { contextMode: "lean", auditMode: "content" },
          "later",
        ),
      )
      const latest = yield* opencode.spawn(["debug", "context", "--history", "--limit", "1"])
      opencode.expectExit(latest, 0, "history page")
      const page = JSON.parse(latest.stdout)
      expect(page.entries.map((entry: { id: string }) => entry.id)).toEqual([second.id])
      expect(page.nextBefore).toBe(second.sequence)
      expect(latest.stdout).not.toContain("SYNTHETIC_PRIVATE_HISTORY")
      const next = yield* opencode.spawn([
        "debug",
        "context",
        "--history",
        "--before",
        String(page.nextBefore),
        "--session-id",
        "ses_history_first",
      ])
      opencode.expectExit(next, 0, "filtered history page")
      expect(JSON.parse(next.stdout).entries.map((entry: { id: string }) => entry.id)).toEqual([first.id])
      const invalid = yield* opencode.spawn(["debug", "context", "--history", "--content"])
      expect(invalid.exitCode).not.toBe(0)
      expect(invalid.stdout + invalid.stderr).not.toContain("SYNTHETIC_PRIVATE_HISTORY")
      const tooMany = yield* opencode.spawn(["debug", "context", "--history", "--limit", "100000"])
      expect(tooMany.exitCode).not.toBe(0)
      expect((yield* ContextHistory.read(file))?.retained.count).toBe(2)
    }),
  60_000,
)

cliIt.live(
  "debug context exposes captured message text only with --content",
  ({ home, opencode }) =>
    Effect.gen(function* () {
      const toolText = "SYNTHETIC_PRIVATE_LOADED_TOOL_BODY"
      const toolReceipt = ToolSource.create({
        kind: "skill",
        origin: "fixture/SKILL.md",
        output: toolText,
        start: 0,
        end: toolText.length,
      })!
      const input: ContextAudit.Input = {
        runtime: "v2",
        purpose: "compaction",
        compactionMessageID: "msg_synthetic_attempt",
        sessionID: "ses_synthetic_audit",
        historySnapshot: {
          id: "snapshot_synthetic",
          count: 2,
          bytes: 36,
          sources: [
            {
              messageID: "msg_saved_source",
              partID: "prt_saved_source",
              messageIndex: 0,
              partIndex: 0,
              text: "SYNTHETIC_PRIVATE_CHECKPOINT_SOURCE",
            },
            {
              source: "loaded-tool-result",
              messageID: "msg_loaded_tool",
              partID: "prt_loaded_tool",
              messageIndex: 1,
              partIndex: 0,
              text: toolText,
              tool: {
                name: "skill",
                callID: "call_loaded",
                observation: ToolSource.inspect(toolText, { contextSource: toolReceipt }),
              },
            },
          ],
        },
        agent: "compaction",
        model: { provider: "test", id: "test" },
        instructions: [{ source: "agent", text: "SYNTHETIC_PRIVATE_INSTRUCTION" }],
        messages: [{ role: "user" }],
        messageSources: [
          {
            source: "compaction-prompt",
            role: "user",
            messageIndex: 0,
            partIndex: 0,
            text: "SYNTHETIC_PRIVATE_HISTORY ação 🌍",
          },
        ],
        tools: [],
      }
      const file = path.join(home, ".local/state/opencode", ContextAudit.FILE)
      yield* Effect.promise(() => fs.mkdir(path.dirname(file), { recursive: true }))
      const content = JSON.stringify(
        ContextAudit.report(input, { contextMode: "standard", auditMode: "content" }, "now"),
      )
      yield* Effect.promise(() => Bun.write(file, content))
      const metadata = yield* opencode.spawn(["debug", "context"])
      opencode.expectExit(metadata, 0, "context metadata")
      expect(metadata.stdout).not.toContain("SYNTHETIC_PRIVATE_INSTRUCTION")
      expect(metadata.stdout).not.toContain("SYNTHETIC_PRIVATE_HISTORY")
      expect(metadata.stdout).not.toContain("SYNTHETIC_PRIVATE_CHECKPOINT_SOURCE")
      expect(metadata.stdout).not.toContain(toolText)
      expect(JSON.parse(metadata.stdout)).toMatchObject({
        purpose: "compaction",
        compactionMessageID: "msg_synthetic_attempt",
        messageSources: [{ source: "compaction-prompt", role: "user" }],
      })
      const shown = yield* opencode.spawn(["debug", "context", "--content"])
      opencode.expectExit(shown, 0, "context content")
      expect(JSON.parse(shown.stdout).instructions[0].content).toBe(input.instructions[0]!.text)
      expect(JSON.parse(shown.stdout).messageSources[0].content).toBe(input.messageSources![0]!.text)
      expect(JSON.parse(shown.stdout).historySnapshot.sources[0].content).toBe(input.historySnapshot!.sources[0]!.text)
      expect(JSON.parse(shown.stdout).historySnapshot.sources[1].content).toBe(toolText)
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(content)

      const summary = JSON.stringify(
        ContextAudit.report(input, { contextMode: "standard", auditMode: "summary" }, "now"),
      )
      yield* Effect.promise(() => Bun.write(file, summary))
      const unavailable = yield* opencode.spawn(["debug", "context", "--content"])
      expect(unavailable.exitCode).not.toBe(0)
      expect(unavailable.stdout + unavailable.stderr).not.toContain("SYNTHETIC_PRIVATE_HISTORY")
      expect(yield* Effect.promise(() => Bun.file(file).text())).toBe(summary)
    }),
  60_000,
)
