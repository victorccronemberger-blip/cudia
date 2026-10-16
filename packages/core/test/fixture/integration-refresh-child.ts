import { Credential } from "@opencode-ai/core/credential"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Integration } from "@opencode-ai/core/integration"
import { Cause, Effect, Exit } from "effect"

const [databasePath, credentialIDInput, refreshURL] = process.argv.slice(2)
if (!databasePath || !credentialIDInput || !refreshURL) throw new Error("Missing refresh child arguments")

const credentialID = Credential.ID.make(credentialIDInput)
const integrationID = Integration.ID.make("integration-refresh-process-fixture")
const methodID = Integration.MethodID.make("oauth")
const runtime = AppNodeBuilder.build(
  LayerNode.group([Integration.node, Credential.node, EventV2.node, Database.node]),
  [[Database.node, Database.layerFromPath(databasePath)]],
)

const result = Effect.gen(function* () {
  const integrations = yield* Integration.Service
  yield* integrations.transform((editor) =>
    editor.method.update({
      integrationID,
      method: { id: methodID, type: "oauth", label: "Process crash fixture" },
      authorize: () => Effect.die("unexpected authorization"),
      refresh: (credential) =>
        Effect.tryPromise({
          try: async (signal) => {
            const response = await fetch(refreshURL, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ refresh: credential.refresh }),
              signal,
            })
            if (!response.ok) throw new Error("Refresh fixture rejected request")
            return Credential.OAuth.make({
              type: "oauth",
              methodID,
              access: "rotated-access-fixture-secret",
              refresh: "rotated-refresh-fixture-secret",
              issued: Date.now(),
              expires: Date.now() + 60 * 60 * 1000,
            })
          },
          catch: () => new Error("Refresh fixture failed"),
        }),
    }),
  )
  return yield* Effect.exit(
    integrations.connection.resolve({ type: "credential", id: credentialID, label: "Refresh fixture" }),
  )
})

const exit = await Effect.runPromise(Effect.scoped(Effect.provide(result, runtime)))
const status = Exit.isFailure(exit)
  ? Cause.squash(exit.cause) instanceof Integration.AuthorizationError
    ? "authorization_required"
    : "unexpected_failure"
  : exit.value?.type === "oauth"
    ? "success"
    : "missing_credential"
if (status === "unexpected_failure" || status === "missing_credential") process.exitCode = 1
console.log(JSON.stringify({ status }))
