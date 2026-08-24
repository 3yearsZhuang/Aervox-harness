/**
 * Aervox｜思隅 @aervox/database — 数据库 DDL 初始化辅助
 *
 * 支持内存数据库和新建 SQLite 文件一键建表与初始化索引。
 */
import type { Client } from "@libsql/client";
import { initFtsTables } from "../search/fts.js";

export async function initDatabaseSchema(client: Client): Promise<void> {
  // 1. 会话与 Turn
  await client.execute(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS sessions_tenant_idx ON sessions(workspace_id, subject_user_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Created',
      last_sequence INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS turns_tenant_idempotency_idx ON turns(workspace_id, subject_user_id, idempotency_key);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(session_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS message_versions (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      content TEXT NOT NULL,
      is_redacted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS message_versions_turn_ver_idx ON message_versions(turn_id, version);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS message_versions_tenant_idx ON message_versions(workspace_id, subject_user_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS turn_stream_events (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_version INTEGER NOT NULL DEFAULT 1,
      data TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS turn_stream_events_turn_seq_idx ON turn_stream_events(turn_id, sequence);
  `);

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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS memory_records_tenant_layer_idx ON memory_records(workspace_id, subject_user_id, layer, is_deleted);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS memory_edges (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      source_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      target_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS memory_projection_overrides (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      memory_record_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      override_type TEXT NOT NULL,
      custom_title TEXT,
      custom_parent_id TEXT,
      is_locked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS diary_schedule_revisions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      cron_time TEXT NOT NULL,
      timezone TEXT NOT NULL,
      initial_window_start TEXT NOT NULL,
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
      created_at TEXT NOT NULL
    );
  `);

  // 4. Outbox 事件
  await client.execute(`
    CREATE TABLE IF NOT EXISTS outbox_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      control_event_id TEXT,
      idempotency_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      published_at TEXT
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS outbox_tenant_idempotency_idx ON outbox_events(workspace_id, subject_user_id, idempotency_key);
  `);

  // 5. 初始化 FTS5 全文检索引擎
  await initFtsTables(client);
}
