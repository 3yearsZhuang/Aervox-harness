/**
 * Aervox｜思隅 @aervox/repositories — audit 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createAuditTables(client: Client): Promise<void> {
  // 缺陷5：Agent 可观测性审计日志（系统级；对齐 observability AuditEntry，payload 为 JSON 文本）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        scope TEXT NOT NULL,
        evidence_ref TEXT,
        payload TEXT,
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS audit_logs_event_created_idx ON audit_logs(event_type, created_at);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS audit_logs_scope_idx ON audit_logs(scope);
    `);
}
