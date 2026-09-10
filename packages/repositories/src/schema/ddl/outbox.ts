/**
 * Aervox｜思隅 @aervox/repositories — outbox 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createOutboxTables(client: Client): Promise<void> {
  // 4. Outbox 事件
    await client.execute(`
      CREATE TABLE IF NOT EXISTS outbox_events (
        id TEXT PRIMARY KEY,
        control_event_id TEXT,
        idempotency_key TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        published_at TEXT
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS outbox_local_idempotency_idx ON outbox_events(idempotency_key);
    `);
}
