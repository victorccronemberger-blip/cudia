import { Schema } from "effect"
import DESCRIPTION from "./shell.txt"
import { PositiveInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"

export type Limits = {
  maxLines: number
  maxBytes: number
}

export function parameterSchema() {
  return Schema.Struct({
    command: Schema.String.annotate({ description: "Command text passed to the configured shell" }),
    timeout: Schema.optional(PositiveInt).annotate({ description: "Timeout in milliseconds" }),
    workdir: Schema.optional(Schema.String).annotate({
      description: "Working directory. Relative paths resolve from the active instance directory.",
    }),
  })
}

export const Parameters = parameterSchema()
export type Parameters = Schema.Schema.Type<typeof Parameters>

function shellGuidance(name: string) {
  if (name === "pwsh") return "PowerShell 7 or later supports the && and || pipeline chain operators."
  if (name === "powershell")
    return "Windows PowerShell 5.1 does not support the && and || pipeline chain operators. Conditional chaining uses cmd1; if ($?) { cmd2 }."
  if (name === "bash") return "Shell syntax: Bash."
  if (name === "cmd") return "Shell syntax: cmd.exe."
  return `Configured shell: ${name}.`
}

export function render(name: string, platform: NodeJS.Platform, limits: Limits, defaultTimeoutMs: number) {
  const values: Record<string, string> = {
    os: platform,
    shell: name,
    syntax: shellGuidance(name),
    tmp: Global.Path.tmp,
    defaultTimeoutMs: String(defaultTimeoutMs),
    maxLines: String(limits.maxLines),
    maxBytes: String(limits.maxBytes),
  }
  return {
    description: DESCRIPTION.replace(/\$\{(\w+)\}/g, (_, key: string) => {
      const value = values[key]
      if (value === undefined) throw new Error(`Missing shell prompt value: ${key}`)
      return value
    }),
    parameters: parameterSchema(),
  }
}

export * as ShellPrompt from "./prompt"
