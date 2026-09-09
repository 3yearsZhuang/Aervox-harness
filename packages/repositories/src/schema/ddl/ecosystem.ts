/**
 * Aervox｜思隅 @aervox/repositories — ecosystem 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";
import { addColumnIfMissing } from "./common.js";

export async function createEcosystemTables(client: Client): Promise<void> {
  // 16. P2/P3 扩展实体：内容/生态域（PRD §8）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS external_sources (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        permission_scope TEXT NOT NULL,
        sync_state TEXT NOT NULL DEFAULT 'idle',
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS external_sources_tenant_provider_idx ON external_sources(workspace_id, subject_user_id, provider);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS plugins (
        id TEXT PRIMARY KEY,
        publisher TEXT NOT NULL,
        version TEXT NOT NULL,
        checksum TEXT NOT NULL,
        signature TEXT,
        permissions TEXT,
        install_source TEXT NOT NULL DEFAULT 'registry',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS plugins_publisher_id_version_idx ON plugins(publisher, id, version);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS plugin_grants (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
        permission TEXT NOT NULL,
        scope TEXT NOT NULL,
        granted_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS plugin_grants_tenant_plugin_perm_idx ON plugin_grants(workspace_id, subject_user_id, plugin_id, permission) WHERE revoked_at IS NULL;
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS community_contents (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        author_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        review_state TEXT NOT NULL DEFAULT 'pending',
        visibility TEXT NOT NULL DEFAULT 'public',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS community_contents_tenant_idx ON community_contents(workspace_id, subject_user_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        member_scope TEXT NOT NULL DEFAULT 'institution',
        policy_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS organizations_tenant_idx ON organizations(workspace_id, subject_user_id);
    `);
  // AST-04 插件元数据列补齐（旧库 addColumnIfMissing 兼容）
    await addColumnIfMissing(client, "plugins", "display_name", "display_name TEXT");
  await addColumnIfMissing(client, "plugins", "repository", "repository TEXT");
  await addColumnIfMissing(client, "plugins", "platforms_json", "platforms_json TEXT");
  await addColumnIfMissing(client, "plugins", "dependencies_json", "dependencies_json TEXT");
  await addColumnIfMissing(client, "plugins", "i18n_json", "i18n_json TEXT");
  await addColumnIfMissing(client, "plugins", "registry_meta_json", "registry_meta_json TEXT");
  await addColumnIfMissing(client, "plugins", "config_schema_json", "config_schema_json TEXT");
  await addColumnIfMissing(client, "plugins", "config_schema_version", "config_schema_version INTEGER NOT NULL DEFAULT 1");
}
