/**
 * Aervox｜思隅 @aervox/repositories — study-materials 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createStudyMaterialsTables(client: Client): Promise<void> {
  // CAP-011 学习资料整理（FR-LRN-002/003、BR-LRN-001）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS study_materials (
        id TEXT PRIMARY KEY,
        goal_id TEXT,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        current_version_id TEXT,
        status TEXT NOT NULL DEFAULT 'generating',
        idempotency_key TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS study_materials_goal_idx ON study_materials(goal_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS material_versions (
        id TEXT PRIMARY KEY,
        material_id TEXT NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
        version INTEGER NOT NULL DEFAULT 1,
        content TEXT NOT NULL,
        format TEXT NOT NULL DEFAULT 'markdown',
        author TEXT NOT NULL DEFAULT 'model',
        superseded_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS material_versions_mat_ver_idx ON material_versions(material_id, version);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS material_sources (
        id TEXT PRIMARY KEY,
        material_version_id TEXT NOT NULL REFERENCES material_versions(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL,
        source_uri TEXT,
        source_title TEXT,
        license_status TEXT NOT NULL DEFAULT 'unconfirmed',
        verification_status TEXT NOT NULL DEFAULT 'needs_review',
        invalidated_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS material_sources_version_idx ON material_sources(material_version_id);
    `);
}
