/**
 * Aervox｜思隅 @aervox/repositories — memories 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";
import { addColumnIfMissing } from "./common.js";

export async function createMemoriesTables(client: Client): Promise<void> {
  // 2. 记忆与记忆树
    await client.execute(`
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        layer TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        canonical_parent_id TEXT,
        source_turn_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        current_revision_id TEXT,
        sensitivity_class TEXT NOT NULL DEFAULT 'normal',
        ai_recall_until TEXT,
        user_retention_until TEXT,
        verification_status TEXT NOT NULL DEFAULT 'unverified',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_records_tenant_layer_idx ON memory_records(workspace_id, subject_user_id, layer, is_deleted);
    `);
  // PET-02 记忆条目字段（新库建列；旧库走下方 addColumnIfMissing 补齐）
    await addColumnIfMissing(client, "memory_records", "source", "source TEXT NOT NULL DEFAULT 'user_said'");
  await addColumnIfMissing(client, "memory_records", "category", "category TEXT NOT NULL DEFAULT 'other'");
  await addColumnIfMissing(client, "memory_records", "keywords_json", "keywords_json TEXT");
  await addColumnIfMissing(client, "memory_records", "last_used_at", "last_used_at TEXT");
  // P1：系统记忆树投影节点（投影层；memory_edges / overrides 迁移到节点级）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        canonical_parent_id TEXT,
        label TEXT NOT NULL,
        node_type TEXT NOT NULL DEFAULT 'concept',
        confidence INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        projection_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_nodes_tenant_idx ON memory_nodes(workspace_id, subject_user_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_nodes_parent_idx ON memory_nodes(canonical_parent_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS memory_edges (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        from_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        to_node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        relation_type TEXT NOT NULL,
        confidence INTEGER NOT NULL DEFAULT 0,
        visibility_scope TEXT NOT NULL DEFAULT 'private',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_edges_tenant_from_idx ON memory_edges(workspace_id, subject_user_id, from_node_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS memory_edge_evidence (
        id TEXT PRIMARY KEY,
        edge_id TEXT NOT NULL REFERENCES memory_edges(id) ON DELETE CASCADE,
        memory_revision_id TEXT NOT NULL REFERENCES memory_revisions(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_edge_evidence_edge_idx ON memory_edge_evidence(edge_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS memory_projection_overrides (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        node_id TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        label TEXT,
        parent_node_id TEXT,
        actor_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_projection_overrides_node_idx ON memory_projection_overrides(node_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS memory_algorithms (
        id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        prompt_version_id TEXT,
        thresholds TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        approved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_algorithms_stage_schema_idx ON memory_algorithms(stage, schema_version);
    `);
}
