import { expect } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Effect } from "effect"
import { ContextAudit } from "@opencode-ai/core/harness/audit"
import { cliIt } from "../lib/cli-process"

cliIt.live(
  "debug context exposes captured message text only with --content",
  ({ home, opencode }) =>
    Effect.gen(function* () {
      const input: ContextAudit.Input = {
        runtime: "v2",
        purpose: "compaction",
        compactionMessageID: "msg_synthetic_attempt",
        sessionID: "ses_synthetic_audit",
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
      expect(JSON.parse(metadata.stdout)).toMatchObject({
        purpose: "compaction",
        compactionMessageID: "msg_synthetic_attempt",
        messageSources: [{ source: "compaction-prompt", role: "user" }],
      })
      const shown = yield* opencode.spawn(["debug", "context", "--content"])
      opencode.expectExit(shown, 0, "context content")
      expect(JSON.parse(shown.stdout).instructions[0].content).toBe(input.instructions[0]!.text)
      expect(JSON.parse(shown.stdout).messageSources[0].content).toBe(input.messageSources![0]!.text)
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
