/**
 * Aervox｜思隅 @aervox/repositories — safety 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createSafetyTables(client: Client): Promise<void> {
  // 10. 安全事件（PRD §8）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS safety_incidents (
        id TEXT PRIMARY KEY,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        disposition TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
}
