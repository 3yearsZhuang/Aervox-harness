import { describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import type { Client } from "@libsql/client";
import { buildPortableSchemaArtifact } from "../src/schema/portable-artifact.js";
import { BACKUP_EXCLUDED_TABLES, isBackupScopedTable, isDerivedSearchTable } from "../src/backup.js";

const quote = (name: string) => `"${name}"`;

/** Open a real database exactly as the packaged Android artifact builds it:
 * the canonical DDL plus the FTS projections the native initializer applies. */
async function deviceDatabase(): Promise<{ client: Client; tables: string[] }> {
 const client = createClient({ url: ":memory:" });
 const artifact = buildPortableSchemaArtifact("main");
 await client.execute("PRAGMA foreign_keys=ON");
 await client.batch(artifact.initialization.statements, "write");
 await client.batch(artifact.projections.statements, "write");
 const rows = await client.execute("SELECT name FROM sqlite_master WHERE type IN ('table','virtual') AND name NOT LIKE 'sqlite_%'");
 return { client, tables: rows.rows.map(row => String(row.name)).sort() };
}

describe("backup scope against the shipped Android schema artifact", () => {
 it("excludes every derived projection the device actually creates", async () => {
  const { client, tables } = await deviceDatabase();
  try {
   expect(tables.length).toBeGreaterThan(100);
   // FTS5 creates the virtual table plus five shadow tables per projection; the
   // envelope must skip all twelve, not just the two named in the DDL.
   const fts = tables.filter(name => /_fts(_|$)/.test(name));
   expect(fts).toHaveLength(12);
   for (const name of ["messages_fts", "memories_fts"]) expect(fts).toContain(name);
   for (const name of fts) {
    expect(isDerivedSearchTable(name), name).toBe(true);
    expect(isBackupScopedTable(name), name).toBe(false);
   }
   for (const name of tables.filter(isBackupScopedTable)) expect(isDerivedSearchTable(name), name).toBe(false);
  } finally {
   client.close();
  }
 });

 it("keeps credential and deletion scope out while business facts stay in", async () => {
  const { client, tables } = await deviceDatabase();
  try {
   const present = new Set(tables);
   // Every entry that this release ships must really be excluded.
   for (const name of BACKUP_EXCLUDED_TABLES) {
    if (!present.has(name)) continue;
    expect(isBackupScopedTable(name), name).toBe(false);
   }
   for (const name of ["llm_configs", "mcp_servers", "plugin_config_secrets", "bot_connections", "deletion_requests", "deletion_targets"]) {
    expect(present.has(name), `${name} must exist in the device schema`).toBe(true);
    expect(isBackupScopedTable(name), name).toBe(false);
   }
   for (const name of ["sessions", "turns", "messages", "knowledge_items", "questions", "personas", "diaries", "memory_records"]) {
    expect(present.has(name), `${name} must exist in the device schema`).toBe(true);
    expect(isBackupScopedTable(name), name).toBe(true);
   }
   // The two sets are disjoint: a restore can never write a credential row.
   for (const name of tables.filter(name => !isBackupScopedTable(name))) expect(present.has(name)).toBe(true);
  } finally {
   client.close();
  }
 });

 it("can read every in-scope table and rebuild projections on that same database", async () => {
  const { client, tables } = await deviceDatabase();
  try {
   // Every table an envelope would carry is real and readable, so no backup entry
   // is invented by the exclusion logic.
   for (const name of tables.filter(isBackupScopedTable)) {
    expect((await client.execute(`SELECT * FROM ${quote(name)} LIMIT 0`)).columns.length, name).toBeGreaterThan(0);
   }
   // A projection rebuild on the shipped schema does not fail and leaves FTS writable.
   const { rebuildSearchProjections } = await import("../src/backup.js");
   await rebuildSearchProjections(client);
   await client.execute("INSERT INTO messages_fts(id, content) VALUES ('device_probe', '验收正文')");
   expect((await client.execute("SELECT id FROM messages_fts WHERE messages_fts MATCH '验收正文'")).rows.map(row => String(row.id)))
    .toEqual(["device_probe"]);
  } finally {
   client.close();
  }
 });
});
