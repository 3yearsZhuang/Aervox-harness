/**
 * Aervox｜思隅 @aervox/repositories — provenance 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createProvenanceTables(client: Client): Promise<void> {
  // 8. 统一来源链 + 记忆版本/证据/事件（PRD §8）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS source_artifacts (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        owner_module TEXT NOT NULL,
        current_revision_id TEXT,
        occurred_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        deleted_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS source_artifacts_tenant_kind_idx ON source_artifacts(workspace_id, subject_user_id, kind);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS source_revisions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL REFERENCES source_artifacts(id) ON DELETE CASCADE,
        checksum TEXT NOT NULL,
        content TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        superseded_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS source_revisions_artifact_version_idx ON source_revisions(artifact_id, version);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS memory_revisions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        confidence INTEGER NOT NULL DEFAULT 0,
        importance INTEGER NOT NULL DEFAULT 0,
        algorithm_version TEXT,
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_revisions_memory_idx ON memory_revisions(memory_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS memory_evidence (
        id TEXT PRIMARY KEY,
        memory_revision_id TEXT NOT NULL REFERENCES memory_revisions(id) ON DELETE CASCADE,
        source_artifact_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        source_range TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_evidence_revision_idx ON memory_evidence(memory_revision_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS memory_events (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        from_tier TEXT,
        to_tier TEXT,
        reason TEXT,
        actor_type TEXT NOT NULL DEFAULT 'system',
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_events_memory_idx ON memory_events(memory_id);
    `);
}
