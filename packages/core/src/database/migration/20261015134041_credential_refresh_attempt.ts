import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261015134041_credential_refresh_attempt",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`credential\` ADD \`refresh_attempt\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
