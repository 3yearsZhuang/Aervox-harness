/**
 * Aervox｜思隅 @aervox/repositories — workspace-skills 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createWorkspaceSkillsTables(client: Client): Promise<void> {
  await client.execute(`
      CREATE TABLE IF NOT EXISTS workspace_skills (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        license TEXT,
        compatibility TEXT,
        metadata TEXT,
        allowed_tools TEXT,
        source TEXT NOT NULL DEFAULT 'workspace',
        version INTEGER NOT NULL DEFAULT 1,
        checksum TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        valid INTEGER NOT NULL DEFAULT 1,
        validation_errors TEXT NOT NULL DEFAULT '[]',
        files_json TEXT NOT NULL,
        skill_markdown TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS workspace_skills_tenant_name_unique_idx ON workspace_skills(workspace_id, subject_user_id, name);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS workspace_skills_tenant_idx ON workspace_skills(workspace_id, subject_user_id);
    `);
}
