/**
 * Aervox｜思隅 @aervox/repositories — DDL 辅助（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

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
