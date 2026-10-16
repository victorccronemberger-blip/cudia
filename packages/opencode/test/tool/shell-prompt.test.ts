import { describe, expect, test } from "bun:test"
import { Result, Schema } from "effect"
import { Parameters, render } from "../../src/tool/shell/prompt"

describe("shell prompt", () => {
  test("describes process, working-directory, timeout, and output behavior", () => {
    const output = render("bash", "linux", { maxLines: 40, maxBytes: 2048 }, 9000).description

    expect(output).toContain("Each invocation starts a new process")
    expect(output).toContain("shell state does not persist between invocations")
    expect(output).toContain("relative paths resolve from the active instance directory")
    expect(output).toContain("defaults to 9000 milliseconds")
    expect(output).toContain("preview is limited to 40 lines and 2048 bytes")
    expect(output).toContain("path to captured output when available")
    expect(output).not.toMatch(/pre-approved|DO NOT|AVOID|must first|Only commit/i)
  })

  test("describes syntax for supported shell profiles", () => {
    expect(render("pwsh", "win32", { maxLines: 10, maxBytes: 100 }, 1000).description).toContain(
      "PowerShell 7 or later supports the && and || pipeline chain operators",
    )
    expect(render("powershell", "win32", { maxLines: 10, maxBytes: 100 }, 1000).description).toContain(
      "Windows PowerShell 5.1 does not support the && and || pipeline chain operators",
    )
    expect(render("cmd", "win32", { maxLines: 10, maxBytes: 100 }, 1000).description).toContain("Shell syntax: cmd.exe")
    expect(render("fish", "linux", { maxLines: 10, maxBytes: 100 }, 1000).description).toContain(
      "Configured shell: fish",
    )
  })

  test("accepts a command with optional positive timeout and workdir", () => {
    const decode = Schema.decodeUnknownResult(Parameters)

    expect(Result.isSuccess(decode({ command: "pwd" }))).toBe(true)
    expect(Result.isSuccess(decode({ command: "pwd", timeout: 1, workdir: "src" }))).toBe(true)
    expect(Result.isSuccess(decode({ timeout: 1 }))).toBe(false)
    expect(Result.isSuccess(decode({ command: "pwd", timeout: 0 }))).toBe(false)
  })
})
