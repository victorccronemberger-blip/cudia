import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { Credential } from "../credential"

export const CredentialTable = sqliteTable("credential", {
  id: text().$type<Credential.ID>().primaryKey(),
  integration_id: text().$type<Credential.Info["integrationID"]>(),
  label: text().notNull(),
  value: text({ mode: "json" }).$type<Credential.Value>().notNull(),
  refresh_attempt: text({ mode: "json" }).$type<{
    readonly nonce: string
    readonly snapshot: string
    readonly time_created: number
  } | null>(),
  connector_id: text(),
  method_id: text(),
  active: integer({ mode: "boolean" }),
  ...Timestamps,
})
