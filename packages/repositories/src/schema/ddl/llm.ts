/**
 * Aervox｜思隅 @aervox/repositories — llm 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";
import { addColumnIfMissing } from "./common.js";

export async function createLlmTables(client: Client): Promise<void> {
  // CR-012 大语言模型与供应商配置（WebUI 设置与运行时模型路由）：每租户多行（多预设，至多一行激活）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS llm_configs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '默认配置',
        is_active INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        provider_type TEXT NOT NULL DEFAULT 'ollama',
        base_url TEXT NOT NULL,
        api_key TEXT,
        model_id TEXT NOT NULL,
        temperature REAL NOT NULL DEFAULT 0.7,
        max_tokens INTEGER DEFAULT 4096,
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await addColumnIfMissing(client, "llm_configs", "name", "name TEXT NOT NULL DEFAULT '默认配置'");
  await addColumnIfMissing(client, "llm_configs", "is_active", "is_active INTEGER NOT NULL DEFAULT 1");
  await client.execute(`DROP INDEX IF EXISTS llm_configs_tenant_unique_idx;`);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS llm_configs_tenant_idx ON llm_configs(workspace_id, subject_user_id);
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS llm_configs_tenant_active_idx ON llm_configs(workspace_id, subject_user_id) WHERE is_active = 1;
    `);
}
