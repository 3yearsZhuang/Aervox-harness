/**
 * Aervox｜思隅 @aervox/repositories — subagent-runs 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createSubagentRunsTables(client: Client): Promise<void> {
  // 4.8 阶段 5c：Subagent 运行关联（subagent_runs；AVX-HAR-001 §13 阶段 5c）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS subagent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_turn_id TEXT NOT NULL,
        parent_attempt_id TEXT NOT NULL,
        parent_execution_id TEXT NOT NULL,
        sub_turn_id TEXT NOT NULL,
        sub_attempt_id TEXT NOT NULL,
        task TEXT NOT NULL,
        tool_scope_json TEXT,
        status TEXT NOT NULL DEFAULT 'Running',
        result_text TEXT,
        error TEXT,
        finished_at TEXT,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS subagent_runs_tenant_parent_idx ON subagent_runs(workspace_id, subject_user_id, parent_turn_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS subagent_runs_tenant_session_idx ON subagent_runs(workspace_id, subject_user_id, session_id);
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS subagent_runs_tenant_parent_exec_idx ON subagent_runs(workspace_id, subject_user_id, parent_attempt_id, parent_execution_id);
    `);
}
