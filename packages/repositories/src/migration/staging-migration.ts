import fs from "node:fs/promises";
import path from "node:path";
import type { Client } from "@libsql/client";
import type { ScopeKey } from "./cr030-migration.js";

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function isVirtualTable(sql: string | null | undefined): boolean {
  return /CREATE\s+VIRTUAL\s+TABLE/i.test(sql ?? "");
}

async function listTables(client: Client): Promise<string[]> {
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return result.rows.map((row) => String(row.name));
}

async function tableColumns(client: Client, table: string): Promise<string[]> {
  const result = await client.execute(`PRAGMA table_info(${quoteIdentifier(table)})`);
  return result.rows.map((row) => String(row.name));
}

async function tableCount(client: Client, table: string): Promise<number> {
  const result = await client.execute(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function hasTable(client: Client, table: string): Promise<boolean> {
  const result = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    args: [table],
  });
  return result.rows.length > 0;
}

async function copyTable(client: Client, staging: Client, table: string, selectedScope?: ScopeKey): Promise<number> {
  const sourceColumns = await tableColumns(client, table);
  if (sourceColumns.length === 0 || !(await hasTable(staging, table))) return 0;
  const targetColumns = new Set(await tableColumns(staging, table));
  const columns = sourceColumns.filter((column) => targetColumns.has(column));
  if (columns.length === 0) return 0;
  let sql = `SELECT ${columns.map(quoteIdentifier).join(", ")} FROM ${quoteIdentifier(table)}`;
  const args: (string | number | null | Uint8Array)[] = [];
  if (selectedScope && sourceColumns.includes("workspace_id") && sourceColumns.includes("subject_user_id")) {
    sql += " WHERE workspace_id = ? AND subject_user_id = ?";
    args.push(selectedScope.workspaceId, selectedScope.subjectUserId);
  }
  const rows = await client.execute({ sql, args });
  const placeholders = columns.map(() => "?").join(", ");
  for (const row of rows.rows) {
    await staging.execute({
      sql: `INSERT INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")}) VALUES (${placeholders})`,
      args: columns.map((column) => row[column] as string | number | null | Uint8Array),
    });
  }
  return rows.rows.length;
}

async function orderedTables(client: Client): Promise<string[]> {
  const tables = await listTables(client);
  const dependencies = new Map<string, Set<string>>();
  for (const table of tables) {
    const result = await client.execute(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`);
    dependencies.set(
      table,
      new Set(result.rows.map((row) => String(row.table)).filter((parent) => tables.includes(parent))),
    );
  }
  const ordered: string[] = [];
  const remaining = new Set(tables);
  while (remaining.size > 0) {
    const ready = [...remaining].filter((table) => [...(dependencies.get(table) ?? [])].every((parent) => !remaining.has(parent)));
    const batch = ready.length > 0 ? ready : [...remaining];
    for (const table of batch) {
      ordered.push(table);
      remaining.delete(table);
    }
  }
  return ordered;
}

export interface StagingBuildResult {
  readonly copiedRowsByTable: Readonly<Record<string, number>>;
  readonly skippedVirtualTables: readonly string[];
}

export async function buildCr030Staging(options: {
  readonly source: Client;
  readonly staging: Client;
  readonly selectedScope?: ScopeKey;
}): Promise<StagingBuildResult> {
  await options.staging.execute("PRAGMA foreign_keys = OFF");
  const copiedRowsByTable: Record<string, number> = {};
  const skippedVirtualTables: string[] = [];
  for (const table of await orderedTables(options.source)) {
    const sqlResult = await options.source.execute({
      sql: "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      args: [table],
    });
    if (isVirtualTable(String(sqlResult.rows[0]?.sql ?? ""))) {
      skippedVirtualTables.push(table);
      continue;
    }
    copiedRowsByTable[table] = await copyTable(options.source, options.staging, table, options.selectedScope);
  }
  await options.staging.execute("PRAGMA foreign_keys = ON");
  return { copiedRowsByTable, skippedVirtualTables };
}

export async function validateCr030Staging(
  staging: Client,
  expectedRowsByTable: Readonly<Record<string, number>>,
): Promise<void> {
  const integrity = await staging.execute("PRAGMA integrity_check");
  if (String(integrity.rows[0]?.integrity_check ?? "") !== "ok") {
    throw new Error("CR-030 staging integrity_check failed");
  }
  const foreignKeys = await staging.execute("PRAGMA foreign_key_check");
  if (foreignKeys.rows.length > 0) throw new Error("CR-030 staging foreign_key_check failed");
  for (const [table, expected] of Object.entries(expectedRowsByTable)) {
    const actual = await tableCount(staging, table);
    if (actual !== expected) throw new Error(`CR-030 staging row count mismatch: ${table} expected ${expected}, got ${actual}`);
  }
}

export async function atomicSwapCr030Database(options: {
  readonly sourcePath: string;
  readonly stagingPath: string;
  readonly rollbackPath: string;
}): Promise<void> {
  const [sourceStat, stagingStat] = await Promise.all([fs.stat(options.sourcePath), fs.stat(options.stagingPath)]);
  if (sourceStat.dev !== stagingStat.dev) throw new Error("CR-030 atomic swap requires one filesystem");
  await fs.rm(options.rollbackPath, { force: true });
  await fs.rename(options.sourcePath, options.rollbackPath);
  try {
    await fs.rename(options.stagingPath, options.sourcePath);
  } catch (error) {
    await fs.rename(options.rollbackPath, options.sourcePath).catch(() => undefined);
    throw error;
  }
  const directoryHandle = await fs.open(path.dirname(options.sourcePath), "r");
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}
