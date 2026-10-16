import path from "node:path"
import { Cause, Effect, Schema } from "effect"
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
        describe: "show captured instruction and message-source text only when content capture was explicitly enabled",
      })
      .option("history", {
        type: "boolean",
        default: false,
        describe: "read bounded historical metadata; requires separate capture opt-in",
      })
      .option("session-id", { type: "string", describe: "filter history by its exact session ID" })
      .option("before", { type: "number", describe: "continue history before this SQLite insertion sequence" })
      .option("limit", { type: "number", describe: "maximum history records per page (1–20)" })
      .check((args) => {
        if (
          !args.history &&
          (args["session-id"] !== undefined || args.before !== undefined || args.limit !== undefined)
        )
          throw new Error("--session-id, --before and --limit require --history")
        if (args.history && (args.content || args.status))
          throw new Error("--history stores metadata only and cannot be combined with --content or --status")
        return true
      }),
  handler: Effect.fn("Cli.debug.context")(function* (args) {
    if (args.history) {
      const history = yield* Effect.tryPromise({
        try: () => import("@opencode-ai/core/harness/audit-history"),
        catch: () => new CliError({ message: "Cannot load context history reader." }),
      })
      const page = yield* history
        .read(path.join(Global.Path.state, history.FILE), {
          sessionID: args["session-id"],
          before: args.before,
          limit: args.limit,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.interrupt
              : fail("Cannot read context history: unavailable, unsupported, invalid query or invalid capture."),
          ),
        )
      if (page === undefined)
        return yield* fail(
          "No context history. Enable CUDIA_CONTEXT_AUDIT=summary (or content) and CUDIA_CONTEXT_AUDIT_HISTORY=1 when running a task.",
        )
      process.stdout.write(
        JSON.stringify({
          storage: "bounded historical metadata; no captured instruction or message text",
          order: "SQLite insertion sequence; not provider execution order",
          lineage:
            "Use explicit message IDs only. Missing captures may reflect retention, disabled auditing or failed persistence.",
          ...page,
        }) + "\n",
      )
      return
    }
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
        "This capture contains metadata only. Start a new task with CUDIA_CONTEXT_AUDIT=content to capture instruction and message-source text explicitly.",
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
          ...(report.messageSources === undefined
            ? {}
            : {
                messageSources: report.messageSources.map(({ content, ...metadata }) => ({
                  ...metadata,
                  ...(args.content && content !== undefined ? { content } : {}),
                })),
              }),
        },
        null,
        2,
      ) + "\n",
    )
  }),
})
