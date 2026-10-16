import { describe, expect, test } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { EventV2Bridge } from "@/event-v2-bridge"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"
import { formatSessionJSON, listSessions, validateMaxCount } from "../../src/cli/cmd/session"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void })),
      ],
    ],
  ),
)

describe("session list CLI", () => {
  test("rejects invalid max-count values", () => {
    expect(validateMaxCount(1)).toBe(true)
    expect(validateMaxCount(1000)).toBe(true)
    expect(() => validateMaxCount(-1)).toThrow("--max-count must be an integer between 1 and 1000")
    expect(() => validateMaxCount(0)).toThrow("--max-count must be an integer between 1 and 1000")
    expect(() => validateMaxCount(1.5)).toThrow("--max-count must be an integer between 1 and 1000")
    expect(() => validateMaxCount(1001)).toThrow("--max-count must be an integer between 1 and 1000")
  })

  it.instance(
    "keeps project scope by default and discovers matching root sessions with --all",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const local = yield* sessions.create({ title: "Local session" })
        const otherDirectory = yield* tmpdirScoped({ git: true })
        const other = yield* provideInstance(otherDirectory)(
          Effect.gen(function* () {
            const service = yield* SessionNs.Service
            return yield* service.create({ title: "Needle from another project" })
          }),
        )

        const localList = yield* listSessions({})
        const allList = yield* listSessions({ all: true, search: "Needle", maxCount: 1 })

        expect(localList.map((session) => session.id)).toContain(local.id)
        expect(localList.map((session) => session.id)).not.toContain(other.id)
        expect(allList.map((session) => session.id)).toEqual([other.id])
        expect(allList[0].directory).toBe(otherDirectory)

        yield* sessions.remove(local.id)
        yield* provideInstance(otherDirectory)(SessionNs.Service.use((service) => service.remove(other.id)))
      }),
    { git: true },
  )

  test("keeps the legacy JSON fields for session list output", () => {
    const session = {
      id: "ses_test" as SessionNs.Info["id"],
      title: "A session",
      time: { created: 10, updated: 20 },
      projectID: "prj_test" as SessionNs.Info["projectID"],
      directory: "C:/project",
    } as SessionNs.Info

    expect(JSON.parse(formatSessionJSON([session]))).toEqual([
      {
        id: "ses_test",
        title: "A session",
        updated: 20,
        created: 10,
        projectId: "prj_test",
        directory: "C:/project",
      },
    ])
  })
})
