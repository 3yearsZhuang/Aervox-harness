/**
 * Aervox｜思隅 @aervox/repositories — feedback 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createFeedbackTables(client: Client): Promise<void> {
  // 7. 反馈域（PRD §8）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS feedback (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        type TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS feedback_subject_idx ON feedback(subject_type, subject_id);
    `);
}
