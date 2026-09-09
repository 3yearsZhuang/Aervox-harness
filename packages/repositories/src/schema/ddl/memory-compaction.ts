/**
 * Aervox｜思隅 @aervox/repositories — memory-compaction 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createMemoryCompactionTables(client: Client): Promise<void> {
  // T-03 上下文压缩标记（新表）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS memory_compaction_markers (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
        snapshot_id TEXT NOT NULL,
        covered_up_to_message_id TEXT,
        summary_text TEXT,
        phase TEXT NOT NULL DEFAULT 'auto',
        status TEXT NOT NULL DEFAULT 'completed',
        thought_duration_ms INTEGER,
        summary_duration_ms INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS memory_compaction_markers_memory_snapshot_idx
      ON memory_compaction_markers(memory_id, snapshot_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_compaction_markers_tenant_idx
      ON memory_compaction_markers(workspace_id, subject_user_id);
    `);
}
