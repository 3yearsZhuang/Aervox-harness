/**
 * Aervox｜思隅 @aervox/repositories — sync 元数据表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

/**
 * P2P 同步行状态表（ITER-028）：
 * 记录每个被同步行的权威来源 `(origin_timestamp, origin_device_id)` 与删除墓碑 `deleted_at`。
 * 纯本地单用户真源的一部分，不含任何租户字段。
 */
export async function createSyncMetadataTables(client: Client): Promise<void> {
  await client.execute(`
      CREATE TABLE IF NOT EXISTS sync_row_state (
        table_name TEXT NOT NULL,
        primary_key TEXT NOT NULL,
        origin_device_id TEXT NOT NULL,
        origin_timestamp TEXT NOT NULL,
        deleted_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (table_name, primary_key)
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS sync_row_state_origin_ts_idx
      ON sync_row_state(table_name, origin_timestamp);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS sync_row_state_tombstone_idx
      ON sync_row_state(deleted_at) WHERE deleted_at IS NOT NULL;
    `);
}
