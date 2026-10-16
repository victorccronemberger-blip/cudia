import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261015201710_session_context_manifest",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` ADD \`baseline_manifest\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
