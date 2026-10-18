import { cmd } from "./cmd"
import { UI } from "../ui"
import { CliError } from "../effect-cmd"

export const ReaCommand = cmd({
  command: "rea <action> [tools..]",
  describe: "install or inspect optional REA tools without changing the global PATH",
  builder: (yargs) =>
    yargs
      .positional("action", { type: "string", choices: ["install", "status"], demandOption: true })
      .positional("tools", { type: "string", array: true })
      .option("json", { type: "boolean", default: false, describe: "print installation status as JSON" }),
  handler: async (args) => {
    const { tools, install, inspect } = await import("@opencode-ai/core/mcp/rea-tools")
    const requested = args.tools?.length
      ? args.tools
      : args.action === "install"
        ? ["wabt"]
        : tools.map((tool) => tool.name)
    // Java engines need a full JDK. Provision it with the requested engine, rather than relying on a new PC's PATH.
    const selected = requested.includes("jadx") || requested.includes("apktool") ? ["jdk", ...requested] : requested
    const unknown = requested.filter((name) => !tools.some((tool) => tool.name === name))
    if (unknown.length)
      throw new CliError({
        message: `Unknown REA tools: ${unknown.join(", ")}. Available: ${tools.map((tool) => tool.name).join(", ")}`,
      })
    const controller = new AbortController()
    const stop = () => controller.abort(new Error("REA installation interrupted"))
    process.once("SIGINT", stop)
    try {
      const statuses = []
      for (const name of [...new Set(selected)]) {
        const tool = tools.find((tool) => tool.name === name)!
        if (args.action === "install" && !args.json) UI.println(`Preparing ${tool.name} ${tool.version}…`)
        const status = await (
          args.action === "install" ? install(tool, undefined, controller.signal) : inspect(tool)
        ).catch((error: unknown) => {
          throw new CliError({
            message: `REA ${name}: ${error instanceof Error ? error.message : String(error)}. Retry with cudia rea ${args.action} ${name}.`,
          })
        })
        statuses.push(status)
        if (!args.json)
          UI.println(
            `${status.name} ${status.version}: ${status.state}${"reason" in status ? ` (${status.reason})` : ""}`,
          )
        if (args.action === "install" && status.state !== "ready")
          throw new CliError({
            message: `REA ${name} installation did not become ready: ${status.reason ?? status.state}`,
          })
      }
      if (args.json) process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`)
      if (!args.json && args.action === "install") UI.println("Ready. Reconnect REA to use the installed tools.")
    } finally {
      process.off("SIGINT", stop)
    }
  },
})
