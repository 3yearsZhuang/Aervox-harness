/**
 * Aervox｜思隅 @aervox/repositories — tool-approvals 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createToolApprovalsTables(client: Client): Promise<void> {
  await client.execute(`
      CREATE TABLE IF NOT EXISTS tool_approvals (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        attempt_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        tool_version TEXT,
        requester TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        decided_by TEXT,
        decided_at TEXT,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS tool_approvals_match_idx ON tool_approvals(tool_name, arguments_hash, state);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS tool_approvals_turn_idx ON tool_approvals(turn_id);
    `);
}
