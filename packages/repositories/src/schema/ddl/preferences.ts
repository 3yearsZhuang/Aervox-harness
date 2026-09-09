/**
 * Aervox｜思隅 @aervox/repositories — preferences 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createPreferencesTables(client: Client): Promise<void> {
  // CAP-010 人格问卷与基础偏好（FR-PER-001/002）：每租户一行
    await client.execute(`
      CREATE TABLE IF NOT EXISTS persona_preferences (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        tone TEXT NOT NULL DEFAULT 'neutral',
        proactiveness TEXT NOT NULL DEFAULT 'medium',
        address_form TEXT NOT NULL DEFAULT 'none',
        reminder_cadence TEXT NOT NULL DEFAULT 'moderate',
        version INTEGER NOT NULL DEFAULT 1,
        skipped INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(workspace_id, subject_user_id)
      );
    `);
}
