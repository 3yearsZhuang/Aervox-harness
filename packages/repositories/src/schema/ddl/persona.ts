/**
 * Aervox｜思隅 @aervox/repositories — persona 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createPersonaTables(client: Client): Promise<void> {
  // 4.6 Persona / Skills / MCP / 上下文快照（CAP-019/CAP-020，@aervox/mod-persona 领域）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS personas (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'user_created',
        status TEXT NOT NULL DEFAULT 'active',
        current_revision_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS persona_revisions (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        config TEXT NOT NULL,
        checksum TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS persona_revisions_persona_revision_idx ON persona_revisions(persona_id, revision);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS persona_revisions_persona_idx ON persona_revisions(persona_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS persona_selections (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        revision_id TEXT NOT NULL,
        selected_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS persona_turn_contexts (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        revision_checksum TEXT NOT NULL,
        prompt_checksum TEXT NOT NULL,
        skill_checksums TEXT NOT NULL DEFAULT '[]',
        mcp_tool_ids TEXT NOT NULL DEFAULT '[]',
        voice TEXT,
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS persona_turn_contexts_local_turn_idx ON persona_turn_contexts(turn_id);
    `);
  // 4.7 CAP-019 扩展：人格模板审核字段 + 切换日志 + 记忆范围
    await client.execute(`
      ALTER TABLE personas ADD COLUMN review_status TEXT NOT NULL DEFAULT 'draft';
    `).catch(() => undefined);
  await client.execute(`
      ALTER TABLE personas ADD COLUMN review_notes TEXT NOT NULL DEFAULT '';
    `).catch(() => undefined);
  await client.execute(`
      ALTER TABLE personas ADD COLUMN reviewed_at TEXT;
    `).catch(() => undefined);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS persona_switch_logs (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        previous_persona_id TEXT,
        previous_revision_id TEXT,
        switch_reason TEXT NOT NULL DEFAULT 'user_initiated',
        regression_notes TEXT,
        switched_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS persona_switch_logs_local_persona_idx ON persona_switch_logs(persona_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS persona_memory_scopes (
        id TEXT PRIMARY KEY,
        persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
        memory_policy TEXT NOT NULL DEFAULT 'isolated',
        shared_persona_ids TEXT NOT NULL DEFAULT '[]',
        shared_categories TEXT NOT NULL DEFAULT '[]',
        confirmed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS persona_memory_scopes_local_persona_idx ON persona_memory_scopes(persona_id);
    `);
}
