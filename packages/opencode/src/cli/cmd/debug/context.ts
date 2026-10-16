import path from "node:path"
import { Effect, Schema } from "effect"
import { Global } from "@opencode-ai/core/global"
import { ContextAudit } from "@opencode-ai/core/harness/audit"
import { AmbientInstructions } from "@opencode-ai/core/harness/ambient-instructions"
import { CliError, effectCmd, fail } from "../../effect-cmd"

export const ContextCommand = effectCmd({
  command: "context",
  describe: "inspect the latest successfully persisted prepared-request capture",
  instance: false,
  builder: (yargs) =>
    yargs
      .option("status", {
        type: "boolean",
        default: false,
        describe: "show this process's instruction-loading choice without a provider request",
      })
      .option("content", {
        type: "boolean",
        default: false,
        describe: "show instruction text only if capture was explicitly enabled with CUDIA_CONTEXT_AUDIT=content",
      }),
  handler: Effect.fn("Cli.debug.context")(function* (args) {
    if (args.status) {
      process.stdout.write(
        JSON.stringify({ ambientInstructions: AmbientInstructions.current(), scope: "current process" }, null, 2) +
          "\n",
      )
      return
    }
    const file = Bun.file(path.join(Global.Path.state, ContextAudit.FILE))
    if (!(yield* Effect.promise(() => file.exists()))) {
      return yield* fail(
        "No context capture. Set CUDIA_CONTEXT_AUDIT=summary (or content), then run a task. Capture does not call a provider on its own.",
      )
    }
    if (file.size > ContextAudit.MAX_REPORT_BYTES) return yield* fail("Context audit exceeds its byte limit.")
    const report = yield* Effect.tryPromise({
      try: async () => Schema.decodeUnknownSync(ContextAudit.StoredReport)(await file.json()),
      catch: () => new CliError({ message: "Cannot read context audit: invalid or unsupported report." }),
    })
    if (args.content && !report.contentIncluded)
      return yield* fail(
        "This capture contains metadata only. Start a new task with CUDIA_CONTEXT_AUDIT=content to capture instruction text explicitly.",
      )
    process.stdout.write(
      JSON.stringify(
        {
          storage: "latest successfully persisted capture; check time, runtime, and sessionID",
          ...report,
          instructions: report.instructions.map(({ content, ...metadata }) => ({
            ...metadata,
            ...(report.version === 1 ? { originState: "missing" } : {}),
            ...(args.content && content !== undefined ? { content } : {}),
          })),
        },
        null,
        2,
      ) + "\n",
    )
  }),
})
