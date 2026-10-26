/** Driver-neutral assembly for the pinned Drizzle LibSQL dialect. The host owns
 * the prepared Client, transaction handles and connection lifecycle. This module
 * never creates a local or remote connection and never initializes a schema.
 */
import type { Client } from "@libsql/client";
import type { Logger } from "drizzle-orm/logger";
import { createTableRelationsHelpers, extractTablesRelationalConfig, type ExtractTablesWithRelations, type RelationalSchemaConfig } from "drizzle-orm/relations";
import { SQLiteAsyncDialect } from "drizzle-orm/sqlite-core/dialect";
import { LibSQLDatabase } from "drizzle-orm/libsql/driver-core";
import { LibSQLSession } from "drizzle-orm/libsql/session";
import * as schema from "@aervox/schema";

export type AervoxDatabase = LibSQLDatabase<typeof schema>;
export type InjectedDatabaseClient = Client;

/** The exported Drizzle classes expose internal constructor seams. Keep this
 * adaptation local to the locked version and exercise its real transaction and
 * declaration contracts when upgrading; do not copy LibSQLSession transactions.
 */
export function createInjectedDatabase(client: InjectedDatabaseClient, options: { logger?: Logger } = {}): AervoxDatabase {
  const tables = extractTablesRelationalConfig(schema, createTableRelationsHelpers);
  const relationConfig: RelationalSchemaConfig<ExtractTablesWithRelations<typeof schema>> = {
    fullSchema: schema, schema: tables.tables as ExtractTablesWithRelations<typeof schema>, tableNamesMap: tables.tableNamesMap,
  };
  const dialect = new SQLiteAsyncDialect();
  const session = new LibSQLSession<typeof schema, ExtractTablesWithRelations<typeof schema>>(
    client, dialect, relationConfig, { logger: options.logger }, undefined,
  );
  return new LibSQLDatabase<typeof schema>("async", dialect, session, relationConfig);
}
