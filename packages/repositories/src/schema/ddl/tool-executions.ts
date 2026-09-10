/**
 * Aervox｜思隅 @aervox/repositories — tool-executions 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createToolExecutionsTables(client: Client): Promise<void> {
  await client.execute(`
      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        invocation_id TEXT NOT NULL,
        name TEXT NOT NULL,
        arguments_json TEXT,
        status TEXT NOT NULL,
        output_json TEXT,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS tool_executions_turn_idx ON tool_executions(turn_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS tool_executions_attempt_idx ON tool_executions(attempt_id);
    `);
  // 2c：幂等预留唯一键（attempt+invocation；旧库经下方 CREATE UNIQUE INDEX 幂等补齐）
    await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS tool_executions_attempt_invocation_idx ON tool_executions(attempt_id, invocation_id);
    `);
}
