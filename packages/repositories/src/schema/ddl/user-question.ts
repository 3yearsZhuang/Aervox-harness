/**
 * Aervox｜思隅 @aervox/repositories — user-question 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createUserQuestionTables(client: Client): Promise<void> {
  // 4.9 缺陷 C：挂起提问会话（pending_user_questions；主键 turnId，expiresAt 为超时唯一真源）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS pending_user_questions (
        turn_id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        questions_json TEXT NOT NULL,
        timeout_ms INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS pending_user_questions_tenant_idx ON pending_user_questions(workspace_id, subject_user_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS pending_user_questions_tenant_expires_idx ON pending_user_questions(workspace_id, subject_user_id, expires_at);
    `);
}
