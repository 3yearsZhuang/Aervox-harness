/**
 * Aervox｜思隅 @aervox/repositories — plugin-config 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createPluginConfigTables(client: Client): Promise<void> {
  await client.execute(`
      CREATE TABLE IF NOT EXISTS plugin_configs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        values_json TEXT NOT NULL,
        secret_keys_json TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        revision INTEGER NOT NULL DEFAULT 0,
        orphaned_values_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS plugin_configs_tenant_plugin_idx ON plugin_configs(workspace_id, subject_user_id, plugin_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS plugin_config_secrets (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL,
        field_key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        configured INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS plugin_config_secrets_tenant_plugin_field_idx ON plugin_config_secrets(workspace_id, subject_user_id, plugin_id, field_key);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS plugin_pages (
        id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL,
        page_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        entry TEXT NOT NULL,
        capabilities_json TEXT NOT NULL,
        checksum TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS plugin_pages_plugin_page_idx ON plugin_pages(plugin_id, page_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS plugin_pages_plugin_idx ON plugin_pages(plugin_id);
    `);
}
