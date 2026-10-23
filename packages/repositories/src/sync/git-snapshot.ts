/** Logical, portable exports. Restore is restricted to an empty, separately owned staging database. */
import type { Client, InValue } from "@libsql/client";
import { quoteSqlIdentifier } from "../schema/manifest.js";

export interface DatabaseSnapshot {
  version: number;
  exportedAt: string;
  tables: Record<string, Array<Record<string, unknown>>>;
}
export const snapshotFileName = (version: number): string => `snapshot-v${version}.json`;
const isMetadata = (name: string): boolean => name === "_migration_journal" || name === "_aervox_schema_versions";

/** PRAGMA classifies every FTS virtual/shadow table, including future custom names. */
export async function listSnapshotTables(client: Client): Promise<string[]> {
  const result = await client.execute("PRAGMA table_list");
  return result.rows.filter((row) => row.schema === "main" && row.type === "table" && !String(row.name).startsWith("sqlite_") && !isMetadata(String(row.name)))
    .map((row) => String(row.name)).sort();
}
function encode(value: unknown): unknown {
  if (typeof value === "bigint") return { $aervoxCell: "bigint", value: value.toString() };
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return { $aervoxCell: "blob", value: Buffer.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value).toString("base64") };
  return value;
}
function decode(value: unknown): InValue {
  if (value == null) return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "object" && "$aervoxCell" in value && "value" in value && typeof value.value === "string") {
    if (value.$aervoxCell === "bigint") return BigInt(value.value);
    if (value.$aervoxCell === "blob") return Buffer.from(value.value, "base64");
  }
  throw new Error("invalid snapshot cell");
}
export async function exportSnapshot(client: Client, version: number): Promise<DatabaseSnapshot> {
  const tables: DatabaseSnapshot["tables"] = {};
  const transaction = await client.transaction("read");
  try {
    for (const table of await listSnapshotTables(transaction as unknown as Client)) {
      const result = await transaction.execute(`SELECT * FROM ${quoteSqlIdentifier(table)}`);
      tables[table] = result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encode(value)])));
    }
    await transaction.commit();
  } catch (error) { await transaction.rollback(); throw error; } finally { transaction.close(); }
  return { version, exportedAt: new Date().toISOString(), tables };
}
export const serializeSnapshot = (snapshot: DatabaseSnapshot): string => JSON.stringify(snapshot, null, 2);

/** No clear/merge option exists. The target must be empty; any failure rolls back the entire import. */
export async function restoreSnapshotToEmptyStaging(client: Client, snapshot: DatabaseSnapshot): Promise<void> {
  const allowed = new Set(await listSnapshotTables(client));
  for (const table of allowed) {
    const count = await client.execute(`SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(table)}`);
    if (Number(count.rows[0]?.count)) throw new Error(`snapshot staging must be empty: ${table}`);
  }
  for (const table of Object.keys(snapshot.tables)) if (!allowed.has(table)) throw new Error(`snapshot contains unsupported table: ${table}`);
  const issues: string[] = [];
  for (const [table, rows] of Object.entries(snapshot.tables)) {
    const info = await client.execute(`PRAGMA table_info(${quoteSqlIdentifier(table)})`);
    const primaryKeys = info.rows.filter((column) => Number(column.pk) > 0).map((column) => String(column.name));
    const seen = new Set<string>();
    rows.forEach((row, index) => {
      for (const key of primaryKeys) if (row[key] == null) issues.push(`${table}[${index}].${key}: NULL or missing primary key`);
      const identity = JSON.stringify(primaryKeys.map((key) => row[key]));
      if (primaryKeys.length && seen.has(identity)) issues.push(`${table}[${index}]: duplicate primary key`);
      seen.add(identity);
    });
  }
  if (issues.length) throw new Error(`snapshot dirty data blocks staging import:\n${issues.join("\n")}`);
  const transaction = await client.transaction("write");
  try {
    // Insertion ordering must never cause cascade deletion; all rows are inserted before FK validation.
    await transaction.execute("PRAGMA defer_foreign_keys = ON");
    for (const [table, rows] of Object.entries(snapshot.tables)) {
      const columnInfo = await transaction.execute(`PRAGMA table_info(${quoteSqlIdentifier(table)})`);
      const columns = columnInfo.rows.map((row) => String(row.name));
      for (const row of rows) {
        const keys = Object.keys(row);
        if (keys.some((key) => !columns.includes(key))) throw new Error(`snapshot contains unsupported column: ${table}`);
        if (!keys.length) throw new Error(`snapshot contains empty row: ${table}`);
        await transaction.execute({ sql: `INSERT INTO ${quoteSqlIdentifier(table)} (${keys.map(quoteSqlIdentifier).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, args: keys.map((key) => decode(row[key])) });
      }
    }
    const foreignKeys = await transaction.execute("PRAGMA foreign_key_check");
    if (foreignKeys.rows.length) throw new Error(`snapshot foreign key check failed: ${JSON.stringify(foreignKeys.rows)}`);
    for (const [table, rows] of Object.entries(snapshot.tables)) {
      const count = await transaction.execute(`SELECT COUNT(*) AS count FROM ${quoteSqlIdentifier(table)}`);
      if (Number(count.rows[0]?.count) !== rows.length) throw new Error(`snapshot count mismatch: ${table}`);
    }
    await transaction.commit();
  } catch (error) { await transaction.rollback(); throw error; } finally { transaction.close(); }
}
