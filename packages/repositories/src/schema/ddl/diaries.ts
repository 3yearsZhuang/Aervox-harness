/**
 * Aervox｜思隅 @aervox/repositories — diaries 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createDiariesTables(client: Client): Promise<void> {
  // 3. 日记与调度周期
    await client.execute(`
      CREATE TABLE IF NOT EXISTS diaries (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        local_date TEXT NOT NULL,
        auto_generated INTEGER NOT NULL DEFAULT 1,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        cycle_id TEXT,
        current_version_id TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  // 条件唯一索引：同一主体同一日期标签仅限一份 auto_generated = 1 自动日记
    await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS diaries_auto_unique_idx ON diaries(workspace_id, subject_user_id, local_date) WHERE auto_generated = 1;
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS diary_cycles (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        schedule_epoch_id TEXT NOT NULL,
        local_date TEXT NOT NULL,
        previous_cutoff_at TEXT NOT NULL,
        cutoff_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'Scheduled',
        schedule_version INTEGER NOT NULL DEFAULT 1,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        diary_id TEXT,
        source_window_start TEXT,
        source_window_end TEXT,
        timezone_snapshot TEXT,
        buffer_closed_at TEXT,
        cursor_committed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS diary_schedule_revisions (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        schedule_id TEXT,
        revision INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        cron_time TEXT NOT NULL,
        timezone TEXT NOT NULL,
        initial_window_start TEXT NOT NULL,
        content_scopes TEXT,
        quiet_hours TEXT,
        effective_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS diary_run_attempts (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL REFERENCES diary_cycles(id) ON DELETE CASCADE,
        schedule_version INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        lease_expires_at TEXT NOT NULL,
        lease_id TEXT,
        fencing_token INTEGER NOT NULL DEFAULT 0,
        idempotency_key TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS diary_schedules (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule_epoch_id TEXT NOT NULL,
        active_from TEXT NOT NULL,
        disabled_at TEXT,
        current_revision_id TEXT,
        next_run_at TEXT,
        last_cutoff_at TEXT,
        initial_window_start TEXT NOT NULL,
        cutoff_rule TEXT NOT NULL,
        buffer_minutes INTEGER NOT NULL DEFAULT 0,
        content_scopes TEXT,
        quiet_hours TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS diary_schedules_tenant_idx ON diary_schedules(workspace_id, subject_user_id, enabled);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS diary_versions (
        id TEXT PRIMARY KEY,
        diary_id TEXT NOT NULL REFERENCES diaries(id) ON DELETE CASCADE,
        perspective TEXT NOT NULL,
        content TEXT NOT NULL,
        model_run_id TEXT,
        created_at TEXT NOT NULL,
        superseded_at TEXT
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS diary_versions_diary_idx ON diary_versions(diary_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS diary_paragraph_sources (
        id TEXT PRIMARY KEY,
        diary_version_id TEXT NOT NULL REFERENCES diary_versions(id) ON DELETE CASCADE,
        paragraph_index INTEGER NOT NULL,
        source_artifact_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        permission_snapshot TEXT
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS diary_paragraph_sources_version_para_idx ON diary_paragraph_sources(diary_version_id, paragraph_index);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS diary_material_buffers (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL REFERENCES diary_cycles(id) ON DELETE CASCADE,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        source_artifact_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        ingested_at TEXT NOT NULL,
        ephemeral_snapshot TEXT,
        permission_snapshot TEXT,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'buffered'
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS diary_material_buffers_cycle_idx ON diary_material_buffers(cycle_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS diary_material_buffers_tenant_idx ON diary_material_buffers(workspace_id, subject_user_id);
    `);
}
