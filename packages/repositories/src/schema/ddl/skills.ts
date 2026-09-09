/**
 * Aervox｜思隅 @aervox/repositories — skills 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createSkillsTables(client: Client): Promise<void> {
  // 18. CAP-020 Skill 能力：注册表 + Neo 生命周期（系统级，无租户列）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS skill_registrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'local',
        active INTEGER NOT NULL DEFAULT 1,
        readonly INTEGER NOT NULL DEFAULT 0,
        version TEXT NOT NULL DEFAULT '1.0.0',
        checksum TEXT,
        plugin_id TEXT,
        gating_conditions_json TEXT,
        content_path TEXT,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS skill_registrations_source_active_idx ON skill_registrations(source, active);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS skill_registrations_plugin_idx ON skill_registrations(plugin_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS skill_payloads (
        payload_ref TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'aervox_skill_v1',
        content_json TEXT NOT NULL,
        checksum TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS skill_candidates (
        candidate_id TEXT PRIMARY KEY,
        skill_key TEXT NOT NULL,
        source_evidence_json TEXT NOT NULL,
        payload_ref TEXT,
        scenario_key TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS skill_candidates_skill_key_status_idx ON skill_candidates(skill_key, status);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS skill_releases (
        release_id TEXT PRIMARY KEY,
        skill_key TEXT NOT NULL,
        stage TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        payload_ref TEXT,
        version INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        synced_to_local INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS skill_releases_skill_stage_version_idx ON skill_releases(skill_key, stage, version);
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS skill_releases_skill_stage_active_idx ON skill_releases(skill_key, stage) WHERE active = 1;
    `);
}
