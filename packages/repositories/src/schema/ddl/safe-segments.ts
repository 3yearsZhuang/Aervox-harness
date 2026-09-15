/**
 * Aervox｜思隅 @aervox/repositories — safe-segments 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createSafeSegmentsTables(client: Client): Promise<void> {
  // E2：安全片段（safe_segments；§12.2「安全片段 + TurnStreamEvent + Draft prefix」原子提交）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS safe_segments (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        attempt_id TEXT,
        sequence INTEGER NOT NULL,
        text TEXT NOT NULL,
        committed INTEGER NOT NULL DEFAULT 0,
        stream_event_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS safe_segments_turn_seq_idx ON safe_segments(turn_id, sequence);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS safe_segments_turn_committed_idx ON safe_segments(turn_id, committed);
    `);
  // Schema 已声明但此前从未真正建出：按 attempt 读取可见前缀（续跑/重放）的查询索引。
  await client.execute(`
      CREATE INDEX IF NOT EXISTS safe_segments_attempt_idx ON safe_segments(attempt_id);
    `);
}
