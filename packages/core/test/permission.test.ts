import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { PermissionSaved } from "@opencode-ai/core/permission/saved"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { eq } from "drizzle-orm"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionStore.node,
      PermissionSaved.node,
      AgentV2.node,
      PermissionV2.node,
    ]),
    [[Location.node, current]],
  ),
)

function setup(rules: PermissionV2.Ruleset = []) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: SessionV2.ID.make("ses_test"),
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* setRules(rules)
  })
}

function setRules(rules: PermissionV2.Ruleset) {
  return Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(AgentV2.ID.make("test"), (agent) => {
        agent.permissions = [...rules]
      }),
    )
  })
}

function assertion(input: Partial<PermissionV2.AssertInput> = {}) {
  return {
    id: PermissionV2.ID.create("per_test"),
    sessionID: SessionV2.ID.make("ses_test"),
    action: "read",
    resources: ["src/index.ts"],
    ...input,
  } satisfies PermissionV2.AssertInput
}

describe("PermissionV2 operator policy", () => {
  it.effect("permits every valid action without approvals, including legacy ask and deny records", () =>
    Effect.gen(function* () {
      yield* setup([{ action: "*", resource: "*", effect: "deny" }])
      const service = yield* PermissionV2.Service
      const events = yield* EventV2.Service
      const asked: string[] = []
      yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === PermissionV2.Event.Asked.type) asked.push(event.type)
        }),
      )
      for (const effect of ["allow", "ask", "deny"] as const) {
        yield* setRules([{ action: "*", resource: "*", effect }])
        for (const action of ["read", "edit", "bash", "lsp", "task", "external_directory", "unknown_future_tool"]) {
          const input = assertion({ action, resources: [".env", "/outside/file", "*"] })
          expect(yield* service.check(input)).toBe("allow")
          expect(yield* service.ask(input)).toEqual({ id: input.id, effect: "allow" })
          yield* service.assert(input)
        }
      }
      expect(asked).toEqual([])
      expect(yield* service.list()).toEqual([])
      expect(yield* service.forSession(SessionV2.ID.make("ses_other"))).toEqual([])
      expect(yield* service.get(PermissionV2.ID.create("per_test"))).toBeUndefined()
    }),
  )

  it.effect("retains legacy rules and saved records without applying them", () =>
    Effect.gen(function* () {
      const rules: PermissionV2.Ruleset = [{ action: "*", resource: "*", effect: "deny" }]
      yield* setup(rules)
      const agents = yield* AgentV2.Service
      const saved = yield* PermissionSaved.Service
      yield* saved.add({ projectID: Project.ID.global, action: "read", resources: ["private/*"] })
      const before = yield* saved.list({ projectID: Project.ID.global })
      const service = yield* PermissionV2.Service
      yield* service.assert(assertion({ resources: ["private/key"] }))
      expect((yield* agents.resolve("test"))?.permissions).toEqual(rules)
      expect(yield* saved.list({ projectID: Project.ID.global })).toEqual(before)
      expect(PermissionV2.evaluate("read", "private/key", rules).effect).toBe("allow")
    }),
  )

  it.effect("rejects missing sessions and agents as identity errors without falling back", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      expect(
        yield* service.check(assertion({ sessionID: SessionV2.ID.make("ses_missing") })).pipe(Effect.flip),
      ).toBeInstanceOf(SessionV2.NotFoundError)
      expect(yield* service.check(assertion({ agent: AgentV2.ID.make("missing") })).pipe(Effect.flip)).toBeInstanceOf(
        PermissionV2.AgentNotFoundError,
      )
      const agents = yield* AgentV2.Service
      yield* agents.transform((draft) => draft.remove(AgentV2.ID.make("test")))
      expect(yield* service.ask(assertion()).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.AgentNotFoundError)
      expect(yield* service.list()).toEqual([])
    }),
  )

  it.effect("resolves an omitted session agent to the existing primary default", () =>
    Effect.gen(function* () {
      yield* setup()
      const database = yield* Database.Service
      yield* database.db
        .update(SessionTable)
        .set({ agent: null })
        .where(eq(SessionTable.id, SessionV2.ID.make("ses_test")))
        .run()
        .pipe(Effect.orDie)
      const agents = yield* AgentV2.Service
      yield* agents.transform((draft) =>
        draft.update(AgentV2.ID.make("build"), (agent) => {
          agent.mode = "primary"
        }),
      )
      const service = yield* PermissionV2.Service
      expect(yield* service.check(assertion())).toBe("allow")
      yield* agents.transform((draft) => {
        draft.remove(AgentV2.ID.make("build"))
        draft.remove(AgentV2.ID.make("test"))
      })
      expect(yield* service.check(assertion()).pipe(Effect.flip)).toBeInstanceOf(PermissionV2.AgentNotFoundError)
    }),
  )

  it.effect("does not fabricate approval requests for legacy replies", () =>
    Effect.gen(function* () {
      yield* setup()
      const service = yield* PermissionV2.Service
      const reply = yield* service
        .reply({ requestID: PermissionV2.ID.create("per_missing"), reply: "always" })
        .pipe(Effect.flip)
      expect(reply).toBeInstanceOf(PermissionV2.NotFoundError)
      expect(yield* service.list()).toEqual([])
    }),
  )
})
