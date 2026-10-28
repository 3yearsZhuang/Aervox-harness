import fs from "node:fs/promises";
import path from "node:path";
import type { Client } from "@libsql/client";

/** Reviewed, one-time identity change. This is never a runtime alias registry. */
export const PLUGIN_IDENTITY_MIGRATIONS = Object.freeze({
  "anki-sync": "ap-tool-anki-sync",
  "bot-onebot": "ap-bot-onebot",
  "bot-weixin": "ap-bot-weixin",
  "diary-distillers": "ap-workflow-diary-distillers",
  "focus-mode": "ap-ui-focus-mode",
  "health-guard": "ap-proactive-health-guard",
  "home-assistant": "ap-tool-home-assistant",
  "multimodal-ocr": "ap-tool-multimodal-ocr",
  "xiaomi-health": "ap-sync-xiaomi-health",
} as const);

/** Append-only evidence retains the original owner; it never authorizes the new identity. */
export const PLUGIN_IDENTITY_HISTORICAL_OWNER_TABLES = new Set([
  "proactive_intervention_receipts", "proactive_budget_feedback_events",
]);

export class PluginIdentityMigrationRequiredError extends Error {
  readonly code = "PLUGIN_IDENTITY_MIGRATION_REQUIRED";
  constructor() {
    super("Legacy first-party plugin identities require the explicit offline plugin identity migration. Stop all hosts and run scripts/migrate-plugin-identities.mjs with a backup and rollback directory.");
    this.name = "PluginIdentityMigrationRequiredError";
  }
}

/** Call before opening any database: an interrupted directory switch must remain closed. */
export async function assertPluginIdentityMigrationUnlocked(dataRoot: string): Promise<void> {
  try {
    await fs.lstat(`${path.resolve(dataRoot)}.plugin-identities.lock`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("PLUGIN_IDENTITY_MIGRATION_LOCKED: complete or recover the offline plugin identity migration before starting any host");
}

/** A data root can be above a nested database or resource directory. Check every ancestor. */
export async function assertPluginIdentityMigrationUnlockedForPath(filename: string): Promise<void> {
  let directory = path.resolve(filename);
  while (true) {
    await assertPluginIdentityMigrationUnlocked(directory);
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

/** Query every relational plugin owner, including detached configuration and Vault rows. */
export async function assertPluginIdentityMigrationReady(client: Pick<Client, "execute">): Promise<void> {
  const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  const oldIds = Object.keys(PLUGIN_IDENTITY_MIGRATIONS);
  for (const item of tables.rows) {
    const table = String(item.name);
    if (PLUGIN_IDENTITY_HISTORICAL_OWNER_TABLES.has(table)) continue;
    const columns = await client.execute(`PRAGMA table_info(${quote(table)})`);
    for (const field of columns.rows) {
      const column = String(field.name);
      if (column !== "plugin_id" && !(table === "plugins" && column === "id")) continue;
      const rows = await client.execute({
        sql: `SELECT 1 FROM ${quote(table)} WHERE ${quote(column)} IN (${oldIds.map(() => "?").join(",")}) LIMIT 1`,
        args: oldIds,
      });
      if (rows.rows.length) throw new PluginIdentityMigrationRequiredError();
    }
  }
}
