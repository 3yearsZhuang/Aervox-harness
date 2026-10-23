import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Bootstrap provenance, scoped to the independently owned main/ledger files. */
export const schemaVersions = sqliteTable("_aervox_schema_versions", {
  scope: text("scope").primaryKey(),
  version: text("version").notNull(),
  fingerprint: text("fingerprint").notNull(),
  appliedAt: text("applied_at").notNull(),
});
