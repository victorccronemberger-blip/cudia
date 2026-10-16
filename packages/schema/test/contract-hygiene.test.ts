import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { Agent } from "../src/agent"
import { FileSystem } from "../src/filesystem"
import { Model } from "../src/model"
import { MCP } from "../src/mcp"
import { Project } from "../src/project"
import { Pty } from "../src/pty"
import { Question } from "../src/question"
import { Session } from "../src/session"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { optional } from "../src/schema"

describe("contract hygiene", () => {
  test("optional properties preserve transformations and omit undefined while encoding", () => {
    const Value = Schema.Struct({ value: optional(Schema.FiniteFromString) })
    expect(Schema.decodeUnknownSync(Value)({ value: "1" })).toEqual({ value: 1 })
    expect(Schema.encodeSync(Value)({ value: 1 })).toEqual({ value: "1" })
    expect(Schema.encodeSync(Value)({ value: undefined })).toEqual({})
  })

  test("todo status and priority preserve arbitrary strings", () => {
    const decode = Schema.decodeUnknownSync(SessionTodo.Info)
    expect(decode({ content: "ship", status: "waiting", priority: "urgent" })).toEqual({
      content: "ship",
      status: "waiting",
      priority: "urgent",
    })
  })

  test("current ID constructors expose create", () => {
    expect(Question.ID.create()).toStartWith("que_")
    expect(Pty.ID.create()).toStartWith("pty_")
  })

  test("reusable public identifiers are stable and unique", () => {
    const identifiers = [
      Agent.Color,
      FileSystem.Submatch,
      Model.Ref,
      Model.Capabilities,
      Model.Cost,
      Model.Api,
      MCP.Status,
      MCP.Authentication,
      MCP.Failure,
      MCP.Server,
      Project.Icon,
      Project.Commands,
      Project.Time,
      Project.Info,
      Pty.Info,
      Session.ListAnchor,
    ].map((schema) => schema.ast.annotations?.identifier)

    expect(identifiers.every((identifier) => typeof identifier === "string")).toBe(true)
    expect(new Set(identifiers).size).toBe(identifiers.length)
  })

  test("current source avoids Any and mutable contract wrappers", async () => {
    const files = [...new Bun.Glob("*.ts").scanSync(fileURLToPath(new URL("../src", import.meta.url)))].filter(
      (file) => !file.endsWith("-v1.ts"),
    )
    const source = await Promise.all(
      files.map((file) => Bun.file(new URL(`../src/${file}`, import.meta.url)).text()),
    ).then((values) => values.join("\n"))

    expect(source).not.toContain("Schema.Any")
    expect(source).not.toContain("Schema.mutable")
  })

  test("MCP server metadata omits absent authentication and errors and validates counts", () => {
    const server = { name: "fixture", status: "disconnected" as const, toolCount: 0, exposureCount: 0 }
    expect(Schema.encodeSync(MCP.Server)({ ...server, authentication: undefined, error: undefined })).toEqual(server)
    expect(Schema.is(MCP.Server)({ ...server, toolCount: -1 })).toBe(false)
    expect(Schema.is(MCP.Server)({ ...server, exposureCount: 1.5 })).toBe(false)
    expect(Schema.is(MCP.Server)({ ...server, status: "needs_auth" })).toBe(false)
    expect(
      [MCP.Status, MCP.Authentication, MCP.Failure, MCP.Server].map((value) => value.ast.annotations?.identifier),
    ).toEqual(["MCP.Status", "MCP.Authentication", "MCP.Failure", "MCP.Server"])
  })
})
