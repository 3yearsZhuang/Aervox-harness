/**
 * Aervox｜思隅 @aervox/repositories — agent-inbox 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createAgentInboxTables(client: Client): Promise<void> {
  // 4.7 阶段 5a：Agent 收件箱（agent_inbox_items；ADR-017）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS agent_inbox_items (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        attempt_id TEXT,
        step_id TEXT,
        type TEXT NOT NULL,
        ordering_seq INTEGER NOT NULL DEFAULT 0,
        source_actor TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        consume_boundary TEXT NOT NULL,
        claimed_at TEXT,
        acked_at TEXT,
        expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS agent_inbox_local_session_idx ON agent_inbox_items(session_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS agent_inbox_status_idx ON agent_inbox_items(status);
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS agent_inbox_local_idempotency_idx ON agent_inbox_items(idempotency_key);
    `);
}
