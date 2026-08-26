/**
 * Aervox｜思隅 @aervox/database — 数据库迁移服务（T-06 接线）
 *
 * 参照 BaiShou-Next 的迁移 journal + 旧库列补齐手法（AGPLv3，仅借鉴公开设计）：
 * - `_migration_journal` 表记录每次已应用迁移（name + applied_at），幂等重入；
 * - 每步迁移为 (name, up) 对，执行后写入 journal；已登记的步骤跳过；
 * - 旧库列补齐（ALTER TABLE ADD COLUMN）作为迁移步骤的一等公民纳入 journal，
 *   解决当前 init.ts 中散落的「CREATE TABLE IF NOT EXISTS 后手动补列」的幂等问题。
 */
import type { Client } from "@libsql/client";

export interface MigrationStep {
  /** 迁移唯一名（如 "v2.add_memory_pet_columns"）；重复执行幂等 */
  name: string;
  /** 迁移主体：执行 DDL/DML，允许幂等写法 */
  up: (client: Client) => Promise<void>;
  /** 描述（登记用） */
  description?: string;
}

const JOURNAL_TABLE = "_migration_journal";

/** 确保 journal 表存在（自举：不登记自身） */
export async function ensureJournalTable(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS ${JOURNAL_TABLE} (
      name TEXT PRIMARY KEY,
      description TEXT,
      applied_at TEXT NOT NULL
    );
  `);
}

/** 已应用的迁移名集合 */
export async function listAppliedMigrations(client: Client): Promise<Set<string>> {
  await ensureJournalTable(client);
  const res = await client.execute(`SELECT name FROM ${JOURNAL_TABLE}`);
  return new Set(res.rows.map((row) => String(row.name)));
}

/** 幂等执行迁移步骤（已应用跳过；未应用的按序执行并登记） */
export async function runMigrations(client: Client, steps: MigrationStep[]): Promise<string[]> {
  await ensureJournalTable(client);
  const applied = await listAppliedMigrations(client);
  const newlyApplied: string[] = [];

  for (const step of steps) {
    if (applied.has(step.name)) continue;
    await step.up(client);
    await client.execute({
      sql: `INSERT INTO ${JOURNAL_TABLE}(name, description, applied_at) VALUES (?, ?, ?)`,
      args: [step.name, step.description ?? null, new Date().toISOString()],
    });
    newlyApplied.push(step.name);
  }

  return newlyApplied;
}

/** 旧库列补齐辅助：列不存在时 ALTER TABLE ADD COLUMN（幂等，友好报错） */
export async function addColumnIfMissing(
  client: Client,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const columns = await client.execute(`PRAGMA table_info(${table})`);
  if (columns.rows.some((row) => String(row.name) === column)) return;
  await client.execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

/** AST-05：迁移完成标记（双条件判定幂等：旧库文件存在 + journal 已登记） */
export async function isMigrationCompleted(
  client: Client,
  migrationName: string,
): Promise<boolean> {
  const applied = await listAppliedMigrations(client);
  return applied.has(migrationName);
}