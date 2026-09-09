/**
 * Aervox｜思隅 @aervox/repositories — platform 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createPlatformTables(client: Client): Promise<void> {
  // 9. 平台/运营域（PRD §8）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS scheduled_jobs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        job_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        run_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS scheduled_jobs_tenant_idempotency_idx ON scheduled_jobs(workspace_id, subject_user_id, idempotency_key);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS scheduled_jobs_tenant_run_idx ON scheduled_jobs(workspace_id, subject_user_id, run_at);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        scheduled_at TEXT NOT NULL,
        sent_at TEXT,
        channel TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'scheduled',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS notifications_tenant_idx ON notifications(workspace_id, subject_user_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS prompt_versions (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        version INTEGER NOT NULL,
        checksum TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        approved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS prompt_versions_purpose_version_idx ON prompt_versions(purpose, version);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS model_runs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        attempt_id TEXT,
        step_id INTEGER,
        purpose TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        prompt_version_id TEXT REFERENCES prompt_versions(id),
        context_manifest_id TEXT,
        latency_ms INTEGER,
        token_usage TEXT,
        cost INTEGER,
        status TEXT NOT NULL DEFAULT 'started',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  // 阶段 7（ADR-017 Expand）：存量库追加 attemptId/stepId（不回填==空；幂等检查列存在）
    const modelRunCols = await client.execute("PRAGMA table_info(model_runs)");
  const modelRunColNames = new Set(modelRunCols.rows.map((r) => r.name));
  if (!modelRunColNames.has("attempt_id")) {
      await client.execute("ALTER TABLE model_runs ADD COLUMN attempt_id TEXT;");
    }
  if (!modelRunColNames.has("step_id")) {
      await client.execute("ALTER TABLE model_runs ADD COLUMN step_id INTEGER;");
    }
  await client.execute(`
      CREATE INDEX IF NOT EXISTS model_runs_tenant_idx ON model_runs(workspace_id, subject_user_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS model_runs_tenant_attempt_idx ON model_runs(workspace_id, subject_user_id, attempt_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS context_manifests (
        id TEXT PRIMARY KEY,
        model_run_id TEXT NOT NULL REFERENCES model_runs(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL,
        source_artifact_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        selection_reason TEXT,
        permission_snapshot TEXT,
        snapshot_json TEXT,
        token_budget INTEGER,
        created_at TEXT NOT NULL
      );
    `);
  const manifestCols = await client.execute("PRAGMA table_info(context_manifests)");
  const manifestColNames = new Set(manifestCols.rows.map((r) => r.name));
  if (!manifestColNames.has("snapshot_json")) {
      await client.execute("ALTER TABLE context_manifests ADD COLUMN snapshot_json TEXT;");
    }
  await client.execute(`
      CREATE INDEX IF NOT EXISTS context_manifests_model_run_idx ON context_manifests(model_run_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS audit_records (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        actor_type TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        subject_type TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        metadata TEXT,
        created_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS audit_records_tenant_actor_idx ON audit_records(workspace_id, subject_user_id, actor_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS audit_records_subject_idx ON audit_records(subject_type, subject_id);
    `);
  // 12. 平台/运营补齐：工具策略 + 评估集（系统级）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS tool_policies (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'all',
        approval_mode TEXT NOT NULL DEFAULT 'auto',
        timeout_ms INTEGER,
        quota INTEGER,
        version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS tool_policies_purpose_tool_version_idx ON tool_policies(purpose, tool_name, version);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS eval_sets (
        id TEXT PRIMARY KEY,
        purpose TEXT NOT NULL,
        version INTEGER NOT NULL,
        language TEXT NOT NULL DEFAULT 'zh-CN',
        domain TEXT NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0,
        annotation_policy TEXT,
        status TEXT NOT NULL DEFAULT 'draft',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS eval_sets_purpose_version_idx ON eval_sets(purpose, version);
    `);
}
