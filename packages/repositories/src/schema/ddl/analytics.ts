/**
 * Aervox｜思隅 @aervox/repositories — analytics 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createAnalyticsTables(client: Client): Promise<void> {
  // 13. 埋点事件（PRD §8）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS analytics_events (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        event_schema_version INTEGER NOT NULL DEFAULT 1,
        occurred_at TEXT NOT NULL,
        analytics_subject_id TEXT NOT NULL,
        context TEXT,
        privacy_class TEXT NOT NULL DEFAULT 'normal'
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS analytics_events_local_event_idx ON analytics_events(event_name, occurred_at);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS analytics_events_subject_idx ON analytics_events(analytics_subject_id);
    `);
}
