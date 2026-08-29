/**
 * Aervox｜思隅 @aervox/database — 数据库 DDL 初始化辅助
 *
 * 支持内存数据库和新建 SQLite 文件一键建表与初始化索引。
 */
import type { Client } from "@libsql/client";
import { initFtsTables } from "../search/fts.js";

async function addColumnIfMissing(
  client: Client,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const columns = await client.execute(`PRAGMA table_info(${table})`);
  if (columns.rows.some((row) => String(row.name) === column)) return;
  await client.execute(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
}

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
      request_hash TEXT,
      accepted_at TEXT,
      cancelled_at TEXT,
      completed_at TEXT,
      quote_message_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS turns_tenant_idempotency_idx ON turns(workspace_id, subject_user_id, idempotency_key);
  `);
  // CAP-013：为存量 turns 表补充 quote_message_id 列（迁移）
  await client.execute(`ALTER TABLE turns ADD COLUMN quote_message_id TEXT;`).catch(() => {});
  await client.execute(`
    CREATE INDEX IF NOT EXISTS turns_session_idx ON turns(session_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS message_versions (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      message_id TEXT,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      content TEXT NOT NULL,
      is_redacted INTEGER NOT NULL DEFAULT 0,
      superseded_at TEXT,
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
      attempt_id TEXT,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_version INTEGER NOT NULL DEFAULT 1,
      data TEXT NOT NULL,
      safety_decision TEXT,
      visibility_revision INTEGER NOT NULL DEFAULT 0,
      occurred_at TEXT NOT NULL,
      committed_at TEXT
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS turn_stream_events_turn_seq_idx ON turn_stream_events(turn_id, sequence);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      current_version_id TEXT,
      label TEXT,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS turn_attempts (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL DEFAULT 1,
      lease_id TEXT,
      fencing_token INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Running',
      started_at TEXT NOT NULL,
      finished_at TEXT,
      lease_expires_at TEXT
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS turn_attempts_turn_attempt_idx ON turn_attempts(turn_id, attempt);
  `);
  // 3b-A：旧库补齐租约过期列（新库已含；ALTER ADD COLUMN 幂等）
  await addColumnIfMissing(client, "turn_attempts", "lease_expires_at", "lease_expires_at TEXT");

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

  // T-03 上下文压缩标记（新表）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS memory_compaction_markers (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL,
      covered_up_to_message_id TEXT,
      summary_text TEXT,
      phase TEXT NOT NULL DEFAULT 'auto',
      status TEXT NOT NULL DEFAULT 'completed',
      thought_duration_ms INTEGER,
      summary_duration_ms INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS memory_compaction_markers_memory_snapshot_idx
    ON memory_compaction_markers(memory_id, snapshot_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS memory_compaction_markers_tenant_idx
    ON memory_compaction_markers(workspace_id, subject_user_id);
  `);

  // T-05 记忆向量独立表（向量数据本体；任务/版本状态在 embedding_indexes）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
      dimension INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      embedding_json TEXT NOT NULL,
      source_created_at TEXT,
      index_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS memory_embeddings_tenant_idx ON memory_embeddings(workspace_id, subject_user_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS memory_embeddings_memory_idx ON memory_embeddings(memory_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS memory_embeddings_model_idx ON memory_embeddings(model_id);
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS memory_embeddings_memory_model_idx
    ON memory_embeddings(workspace_id, subject_user_id, memory_id, model_id);
  `);

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

  // 6. 学习/练习/复习域（PRD §8）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS learning_goals (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'beginner',
      available_minutes INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await addColumnIfMissing(client, "learning_goals", "idempotency_key", "idempotency_key TEXT");
  await client.execute(`
    CREATE INDEX IF NOT EXISTS learning_goals_tenant_idx ON learning_goals(workspace_id, subject_user_id);
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS learning_goals_tenant_idempotency_idx
    ON learning_goals(workspace_id, subject_user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      source_artifact_id TEXT,
      knowledge_id TEXT REFERENCES knowledge_items(id),
      prompt TEXT NOT NULL,
      answer_spec TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await addColumnIfMissing(client, "questions", "knowledge_id", "knowledge_id TEXT");
  await client.execute(`
    CREATE INDEX IF NOT EXISTS questions_tenant_idx ON questions(workspace_id, subject_user_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS questions_source_artifact_idx ON questions(source_artifact_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS questions_knowledge_idx ON questions(knowledge_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS question_attempts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      question_id TEXT NOT NULL REFERENCES questions(id),
      answer TEXT NOT NULL,
      judgement TEXT NOT NULL,
      evidence TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL
    );
  `);
  await addColumnIfMissing(client, "question_attempts", "idempotency_key", "idempotency_key TEXT");
  // CAP-016：难度、提示次数、耗时
  await addColumnIfMissing(client, "question_attempts", "difficulty", "difficulty INTEGER");
  await addColumnIfMissing(client, "question_attempts", "hint_count", "hint_count INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "question_attempts", "time_spent_sec", "time_spent_sec INTEGER");
  await client.execute(`
    CREATE INDEX IF NOT EXISTS question_attempts_session_question_idx ON question_attempts(session_id, question_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS question_attempts_tenant_idx ON question_attempts(workspace_id, subject_user_id);
  `);
  await client.execute(`DROP INDEX IF EXISTS question_attempts_tenant_idempotency_idx;`);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS question_attempts_tenant_question_idempotency_idx
    ON question_attempts(workspace_id, subject_user_id, question_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS mistake_dispositions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      question_id TEXT NOT NULL REFERENCES questions(id),
      status TEXT NOT NULL DEFAULT 'active',
      reason TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, subject_user_id, question_id)
    );
  `);
  await addColumnIfMissing(client, "mistake_dispositions", "reason", "reason TEXT");
  await addColumnIfMissing(client, "mistake_dispositions", "note", "note TEXT");

  await client.execute(`
    CREATE TABLE IF NOT EXISTS mistake_insights (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      question_id TEXT NOT NULL REFERENCES questions(id),
      reason_code TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, subject_user_id, question_id)
    );
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS practice_sessions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      question_count INTEGER NOT NULL,
      question_ids TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      started_at TEXT NOT NULL,
      ended_at TEXT
    );
  `);
  await addColumnIfMissing(client, "practice_sessions", "question_ids", "question_ids TEXT NOT NULL DEFAULT '[]'");
  await client.execute(`
    CREATE INDEX IF NOT EXISTS practice_sessions_tenant_idx ON practice_sessions(workspace_id, subject_user_id);
  `);

  // CAP-016：练习报告
  await client.execute(`
    CREATE TABLE IF NOT EXISTS practice_reports (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      total_questions INTEGER NOT NULL DEFAULT 0,
      correct_count INTEGER NOT NULL DEFAULT 0,
      incorrect_count INTEGER NOT NULL DEFAULT 0,
      avg_time_spent_sec INTEGER,
      total_hints_used INTEGER NOT NULL DEFAULT 0,
      mastery_prediction REAL,
      bias_assessment TEXT,
      report_type TEXT NOT NULL DEFAULT 'summary',
      is_reset INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS practice_reports_tenant_idx ON practice_reports(workspace_id, subject_user_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS practice_reports_session_idx ON practice_reports(session_id);
  `);

  // CAP-017：学习规划（里程碑 + 任务路线图）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS learning_plans (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      topic TEXT NOT NULL,
      level TEXT NOT NULL DEFAULT 'beginner',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      learning_objective TEXT NOT NULL,
      gains TEXT NOT NULL DEFAULT '[]',
      daily_available_minutes INTEGER NOT NULL DEFAULT 25,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS learning_plans_tenant_idx ON learning_plans(workspace_id, subject_user_id);
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS plan_milestones (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      briefing TEXT,
      completion_criteria TEXT,
      debrief TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS plan_milestones_tenant_idx ON plan_milestones(workspace_id, subject_user_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS plan_milestones_plan_idx ON plan_milestones(plan_id);
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS plan_tasks (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      milestone_id TEXT NOT NULL REFERENCES plan_milestones(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      hints TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'todo',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS plan_tasks_tenant_idx ON plan_tasks(workspace_id, subject_user_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS plan_tasks_milestone_idx ON plan_tasks(milestone_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS knowledge_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      concept TEXT NOT NULL,
      source_status TEXT NOT NULL DEFAULT 'inferred',
      mastery_state TEXT NOT NULL DEFAULT 'unknown',
      correct_count INTEGER NOT NULL DEFAULT 0,
      wrong_count INTEGER NOT NULL DEFAULT 0,
      correct_streak INTEGER NOT NULL DEFAULT 0,
      mastery REAL NOT NULL DEFAULT 0,
      mastery_basis TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await addColumnIfMissing(client, "knowledge_items", "correct_count", "correct_count INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "knowledge_items", "wrong_count", "wrong_count INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "knowledge_items", "correct_streak", "correct_streak INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "knowledge_items", "mastery", "mastery REAL NOT NULL DEFAULT 0");
  await client.execute(`
    CREATE INDEX IF NOT EXISTS knowledge_items_tenant_idx ON knowledge_items(workspace_id, subject_user_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS review_items (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
      due_at TEXT NOT NULL,
      interval_days INTEGER NOT NULL DEFAULT 1,
      scheduler_version INTEGER NOT NULL DEFAULT 1,
      timezone_snapshot TEXT NOT NULL DEFAULT 'UTC',
      status TEXT NOT NULL DEFAULT 'active',
      completion_is_correct INTEGER,
      next_review_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS review_items_tenant_knowledge_active_idx ON review_items(workspace_id, subject_user_id, knowledge_id) WHERE status = 'active';
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS review_items_tenant_due_idx ON review_items(workspace_id, subject_user_id, due_at);
  `);
  await addColumnIfMissing(client, "review_items", "completion_is_correct", "completion_is_correct INTEGER");
  await addColumnIfMissing(client, "review_items", "next_review_id", "next_review_id TEXT");
  await addColumnIfMissing(client, "review_items", "timezone_snapshot", "timezone_snapshot TEXT NOT NULL DEFAULT 'UTC'");

  // 7. 反馈域（PRD §8）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS feedback (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      type TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS feedback_subject_idx ON feedback(subject_type, subject_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS feedback_tenant_idx ON feedback(workspace_id, subject_user_id);
  `);

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

  // 缺陷5：Agent 可观测性审计日志（系统级；对齐 observability AuditEntry，payload 为 JSON 文本）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      event_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      action TEXT NOT NULL,
      scope TEXT NOT NULL,
      evidence_ref TEXT,
      payload TEXT,
      created_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS audit_logs_event_created_idx ON audit_logs(event_type, created_at);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS audit_logs_scope_idx ON audit_logs(scope);
  `);

  // 10. 安全事件（PRD §8）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS safety_incidents (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      category TEXT NOT NULL,
      severity TEXT NOT NULL,
      disposition TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS safety_incidents_tenant_idx ON safety_incidents(workspace_id, subject_user_id);
  `);

  // 11. 隐私/删除域（PRD §8）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS consent_grants (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      purpose TEXT NOT NULL,
      scope TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      granted_at TEXT NOT NULL,
      revoked_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS consent_grants_tenant_purpose_scope_idx ON consent_grants(workspace_id, subject_user_id, purpose, scope) WHERE revoked_at IS NULL;
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS deletion_requests (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      effective_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      owner_module TEXT NOT NULL,
      last_verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS deletion_requests_tenant_idempotency_idx ON deletion_requests(workspace_id, subject_user_id, idempotency_key);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS deletion_targets (
      request_id TEXT NOT NULL REFERENCES deletion_requests(id) ON DELETE CASCADE,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      owner_module TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      verified_at TEXT,
      evidence_ref TEXT,
      PRIMARY KEY (request_id, target_type, target_id)
    );
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

  // 13. 埋点事件（PRD §8）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS analytics_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      event_name TEXT NOT NULL,
      event_schema_version INTEGER NOT NULL DEFAULT 1,
      occurred_at TEXT NOT NULL,
      analytics_subject_id TEXT NOT NULL,
      context TEXT,
      privacy_class TEXT NOT NULL DEFAULT 'normal'
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS analytics_events_tenant_event_idx ON analytics_events(workspace_id, subject_user_id, event_name, occurred_at);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS analytics_events_subject_idx ON analytics_events(analytics_subject_id);
  `);

  // 14. 内容/资源域（PRD §8）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      object_key TEXT NOT NULL,
      media_type TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      scan_status TEXT NOT NULL DEFAULT 'pending',
      source_license TEXT,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS attachments_tenant_idx ON attachments(workspace_id, subject_user_id);
  `);
  // CAP-012：扩展 attachments 表（用途声明、解析状态、幂等键）
  await addColumnIfMissing(client, "attachments", "purpose", "purpose TEXT");
  await addColumnIfMissing(client, "attachments", "parse_status", "parse_status TEXT NOT NULL DEFAULT 'pending'");
  await addColumnIfMissing(client, "attachments", "idempotency_key", "idempotency_key TEXT");

  // CAP-012 FR-EXT-002：附件解析结果表
  await client.execute(`
    CREATE TABLE IF NOT EXISTS attachment_parse_results (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      parse_status TEXT NOT NULL DEFAULT 'pending',
      parsed_text TEXT,
      confidence INTEGER,
      parse_error TEXT,
      crop_data TEXT,
      operation TEXT NOT NULL DEFAULT 'ocr',
      idempotency_key TEXT,
      superseded_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS attachment_parse_results_attachment_idx ON attachment_parse_results(attachment_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS attachment_parse_results_tenant_idx ON attachment_parse_results(workspace_id, subject_user_id);
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS attachment_parse_results_idem_idx
    ON attachment_parse_results(workspace_id, subject_user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS embedding_indexes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      source_artifact_id TEXT NOT NULL,
      source_revision_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      dimension INTEGER NOT NULL DEFAULT 0,
      index_version INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS embedding_indexes_tenant_idx ON embedding_indexes(workspace_id, subject_user_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS embedding_indexes_source_idx ON embedding_indexes(source_artifact_id);
  `);

  // 15. P1：会话地图分支 + 知识关系（PRD §8）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS conversation_branches (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      fork_at_message_id TEXT,
      child_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS conversation_branches_parent_idx ON conversation_branches(parent_session_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS conversation_branches_tenant_idx ON conversation_branches(workspace_id, subject_user_id);
  `);
  // CAP-014：扩展分支表（标题、原因、状态、布局、软删除）
  await addColumnIfMissing(client, "conversation_branches", "title", "title TEXT");
  await addColumnIfMissing(client, "conversation_branches", "branch_reason", "branch_reason TEXT");
  await addColumnIfMissing(client, "conversation_branches", "status", "status TEXT NOT NULL DEFAULT 'active'");
  await addColumnIfMissing(client, "conversation_branches", "merged_at", "merged_at TEXT");
  await addColumnIfMissing(client, "conversation_branches", "layout_data", "layout_data TEXT");
  await addColumnIfMissing(client, "conversation_branches", "deleted_at", "deleted_at TEXT");
  await client.execute(`
    CREATE INDEX IF NOT EXISTS conversation_branches_status_idx ON conversation_branches(status);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS knowledge_relations (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      from_knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
      to_knowledge_id TEXT NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'inference',
      confidence INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS knowledge_relations_tenant_from_idx ON knowledge_relations(workspace_id, subject_user_id, from_knowledge_id);
  `);
  // CAP-015：扩展知识关系表（纠正状态、合并/拆分、软删除）
  await addColumnIfMissing(client, "knowledge_relations", "correction_status", "correction_status TEXT NOT NULL DEFAULT 'active'");
  await addColumnIfMissing(client, "knowledge_relations", "correction_reason", "correction_reason TEXT");
  await addColumnIfMissing(client, "knowledge_relations", "merged_into", "merged_into TEXT");
  await addColumnIfMissing(client, "knowledge_relations", "deleted_at", "deleted_at TEXT");
  await client.execute(`
    CREATE INDEX IF NOT EXISTS knowledge_relations_correction_idx ON knowledge_relations(correction_status);
  `);

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

  // 4.6 Persona / Skills / MCP / 上下文快照（CAP-019/CAP-020，@aervox/mod-persona 领域）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS personas (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'user_created',
      status TEXT NOT NULL DEFAULT 'active',
      current_revision_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS personas_tenant_idx ON personas(workspace_id, subject_user_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS persona_revisions (
      id TEXT PRIMARY KEY,
      persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      config TEXT NOT NULL,
      checksum TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS persona_revisions_persona_revision_idx ON persona_revisions(persona_id, revision);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS persona_revisions_persona_idx ON persona_revisions(persona_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS persona_selections (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      revision_id TEXT NOT NULL,
      selected_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS persona_selections_tenant_unique_idx ON persona_selections(workspace_id, subject_user_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS workspace_skills (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      license TEXT,
      compatibility TEXT,
      metadata TEXT,
      allowed_tools TEXT,
      source TEXT NOT NULL DEFAULT 'workspace',
      version INTEGER NOT NULL DEFAULT 1,
      checksum TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      valid INTEGER NOT NULL DEFAULT 1,
      validation_errors TEXT NOT NULL DEFAULT '[]',
      files_json TEXT NOT NULL,
      skill_markdown TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS workspace_skills_tenant_name_unique_idx ON workspace_skills(workspace_id, subject_user_id, name);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS workspace_skills_tenant_idx ON workspace_skills(workspace_id, subject_user_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS mcp_tools (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      input_schema TEXT,
      scopes TEXT NOT NULL DEFAULT '[]',
      healthy INTEGER NOT NULL DEFAULT 1,
      authorized INTEGER NOT NULL DEFAULT 1,
      revoked INTEGER NOT NULL DEFAULT 0,
      kill_switch INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS mcp_tools_tenant_server_name_idx ON mcp_tools(workspace_id, subject_user_id, server_id, name);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS mcp_tools_tenant_idx ON mcp_tools(workspace_id, subject_user_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS persona_turn_contexts (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      revision_checksum TEXT NOT NULL,
      prompt_checksum TEXT NOT NULL,
      skill_checksums TEXT NOT NULL DEFAULT '[]',
      mcp_tool_ids TEXT NOT NULL DEFAULT '[]',
      voice TEXT,
      created_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS persona_turn_contexts_tenant_turn_idx ON persona_turn_contexts(workspace_id, subject_user_id, turn_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS persona_turn_contexts_tenant_idx ON persona_turn_contexts(workspace_id, subject_user_id);
  `);

  // 4.7 CAP-019 扩展：人格模板审核字段 + 切换日志 + 记忆范围
  await client.execute(`
    ALTER TABLE personas ADD COLUMN review_status TEXT NOT NULL DEFAULT 'draft';
  `).catch(() => undefined);
  await client.execute(`
    ALTER TABLE personas ADD COLUMN review_notes TEXT NOT NULL DEFAULT '';
  `).catch(() => undefined);
  await client.execute(`
    ALTER TABLE personas ADD COLUMN reviewed_at TEXT;
  `).catch(() => undefined);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS persona_switch_logs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      previous_persona_id TEXT,
      previous_revision_id TEXT,
      switch_reason TEXT NOT NULL DEFAULT 'user_initiated',
      regression_notes TEXT,
      switched_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS persona_switch_logs_tenant_idx ON persona_switch_logs(workspace_id, subject_user_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS persona_switch_logs_tenant_persona_idx ON persona_switch_logs(workspace_id, subject_user_id, persona_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS persona_memory_scopes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      memory_policy TEXT NOT NULL DEFAULT 'isolated',
      shared_persona_ids TEXT NOT NULL DEFAULT '[]',
      shared_categories TEXT NOT NULL DEFAULT '[]',
      confirmed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS persona_memory_scopes_tenant_persona_idx ON persona_memory_scopes(workspace_id, subject_user_id, persona_id);
  `);

  // 5. 初始化 FTS5 全文检索引擎
  await initFtsTables(client);

  // 17. T-04 工具注册表 + AST-04 条件门控（系统级，无租户列）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS tool_registrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      safety_level TEXT NOT NULL DEFAULT 'write_with_approval',
      replay TEXT,
      required_permissions_json TEXT,
      input_schema_json TEXT,
      builtin INTEGER NOT NULL DEFAULT 0,
      plugin_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      gating_conditions_json TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS tool_registrations_plugin_idx ON tool_registrations(plugin_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS tool_registrations_category_enabled_idx ON tool_registrations(category, enabled);
  `);
  // B3：工具结果未知恢复复议声明（never/safe；未声明 = fail-closed 收敛）；旧库幂等补齐
  await addColumnIfMissing(client, "tool_registrations", "replay", "replay TEXT");

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

  // AST-04 插件元数据列补齐（旧库 addColumnIfMissing 兼容）
  await addColumnIfMissing(client, "plugins", "display_name", "display_name TEXT");
  await addColumnIfMissing(client, "plugins", "repository", "repository TEXT");
  await addColumnIfMissing(client, "plugins", "platforms_json", "platforms_json TEXT");
  await addColumnIfMissing(client, "plugins", "dependencies_json", "dependencies_json TEXT");
  await addColumnIfMissing(client, "plugins", "i18n_json", "i18n_json TEXT");
  await addColumnIfMissing(client, "plugins", "registry_meta_json", "registry_meta_json TEXT");
  await addColumnIfMissing(client, "plugins", "config_schema_json", "config_schema_json TEXT");
  await addColumnIfMissing(client, "plugins", "config_schema_version", "config_schema_version INTEGER NOT NULL DEFAULT 1");

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

  // CAP-010 人格问卷与基础偏好（FR-PER-001/002）：每租户一行
  await client.execute(`
    CREATE TABLE IF NOT EXISTS persona_preferences (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      tone TEXT NOT NULL DEFAULT 'neutral',
      proactiveness TEXT NOT NULL DEFAULT 'medium',
      address_form TEXT NOT NULL DEFAULT 'none',
      reminder_cadence TEXT NOT NULL DEFAULT 'moderate',
      version INTEGER NOT NULL DEFAULT 1,
      skipped INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(workspace_id, subject_user_id)
    );
  `);

  // CAP-011 学习资料整理（FR-LRN-002/003、BR-LRN-001）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS study_materials (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS study_materials_tenant_idx ON study_materials(workspace_id, subject_user_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS study_materials_goal_idx ON study_materials(goal_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS material_versions (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL REFERENCES study_materials(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS material_versions_tenant_idx ON material_versions(workspace_id, subject_user_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS material_sources (
      id TEXT PRIMARY KEY,
      material_version_id TEXT NOT NULL REFERENCES material_versions(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
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
  await client.execute(`
    CREATE INDEX IF NOT EXISTS material_sources_tenant_idx ON material_sources(workspace_id, subject_user_id);
  `);

  // CR-011 语音输出配置（系统核心能力 · 本地语音模型配置）：每租户一行本地语音模型
  await client.execute(`
    CREATE TABLE IF NOT EXISTS voice_configs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      provider_id TEXT NOT NULL,
      model_path TEXT,
      model_id TEXT NOT NULL,
      speaker_id TEXT,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS voice_configs_tenant_unique_idx ON voice_configs(workspace_id, subject_user_id);
  `);

  // CR-012 大语言模型与供应商配置（WebUI 设置与运行时模型路由）：每租户一行
  await client.execute(`
    CREATE TABLE IF NOT EXISTS llm_configs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
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
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS llm_configs_tenant_unique_idx ON llm_configs(workspace_id, subject_user_id);
  `);
// CR-016 离线语音输入 (ASR) 配置持久化：每租户一行
  await client.execute(`
    CREATE TABLE IF NOT EXISTS voice_input_configs (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      engine_type TEXT NOT NULL DEFAULT 'sensevoice-local',
      model_path TEXT,
      model_id TEXT NOT NULL DEFAULT 'sensevoice-small',
      endpoint TEXT,
      api_key TEXT,
      auto_stop_on_keyboard INTEGER NOT NULL DEFAULT 1,
      vad_silence_threshold_ms INTEGER NOT NULL DEFAULT 700,
      settings_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS voice_input_configs_tenant_unique_idx ON voice_input_configs(workspace_id, subject_user_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS tool_executions (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      name TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      arguments_json TEXT,
      status TEXT NOT NULL,
      output_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS tool_executions_turn_idx ON tool_executions(turn_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS tool_executions_attempt_idx ON tool_executions(attempt_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS tool_executions_tenant_idx ON tool_executions(workspace_id, subject_user_id);
  `);
  // 2c：幂等预留唯一键（attempt+invocation；旧库经下方 CREATE UNIQUE INDEX 幂等补齐）
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS tool_executions_attempt_invocation_idx ON tool_executions(attempt_id, invocation_id);
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS tool_approvals (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      attempt_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      tool_version TEXT,
      requester TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      decided_by TEXT,
      decided_at TEXT,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS tool_approvals_match_idx ON tool_approvals(tool_name, arguments_hash, state);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS tool_approvals_turn_idx ON tool_approvals(turn_id);
  `);
  // E2：安全片段（safe_segments；§12.2「安全片段 + TurnStreamEvent + Draft prefix」原子提交）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS safe_segments (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      attempt_id TEXT,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      text TEXT NOT NULL,
      committed INTEGER NOT NULL DEFAULT 0,
      stream_event_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS safe_segments_turn_seq_idx ON safe_segments(turn_id, sequence);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS safe_segments_turn_committed_idx ON safe_segments(turn_id, committed);
  `);
  // 4.7 阶段 5a：Agent 收件箱（agent_inbox_items；ADR-017）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS agent_inbox_items (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      session_id TEXT NOT NULL,
      attempt_id TEXT,
      step_id TEXT,
      type TEXT NOT NULL,
      ordering_seq INTEGER NOT NULL DEFAULT 0,
      source_actor TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      consume_boundary TEXT NOT NULL,
      claimed_at TEXT,
      acked_at TEXT,
      expires_at TEXT,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS agent_inbox_tenant_session_idx ON agent_inbox_items(workspace_id, subject_user_id, session_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS agent_inbox_status_idx ON agent_inbox_items(status);
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS agent_inbox_tenant_idempotency_idx ON agent_inbox_items(workspace_id, subject_user_id, idempotency_key);
  `);
  // 4.8 阶段 5c：Subagent 运行关联（subagent_runs；AVX-HAR-001 §13 阶段 5c）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS subagent_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_turn_id TEXT NOT NULL,
      parent_attempt_id TEXT NOT NULL,
      parent_execution_id TEXT NOT NULL,
      sub_turn_id TEXT NOT NULL,
      sub_attempt_id TEXT NOT NULL,
      task TEXT NOT NULL,
      tool_scope_json TEXT,
      status TEXT NOT NULL DEFAULT 'Running',
      result_text TEXT,
      error TEXT,
      finished_at TEXT,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS subagent_runs_tenant_parent_idx ON subagent_runs(workspace_id, subject_user_id, parent_turn_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS subagent_runs_tenant_session_idx ON subagent_runs(workspace_id, subject_user_id, session_id);
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS subagent_runs_tenant_parent_exec_idx ON subagent_runs(workspace_id, subject_user_id, parent_attempt_id, parent_execution_id);
  `);
  // 4.9 缺陷 C：挂起提问会话（pending_user_questions；主键 turnId，expiresAt 为超时唯一真源）
  await client.execute(`
    CREATE TABLE IF NOT EXISTS pending_user_questions (
      turn_id TEXT PRIMARY KEY,
      attempt_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      questions_json TEXT NOT NULL,
      timeout_ms INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS pending_user_questions_tenant_idx ON pending_user_questions(workspace_id, subject_user_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS pending_user_questions_tenant_expires_idx ON pending_user_questions(workspace_id, subject_user_id, expires_at);
  `);

  // CAP-033 主动智能模式：版本化全量画像授权与本地处理数据面。
  // 所有正文/派生表均显式带 processing_boundary，且不接入 outbox/远程同步表。
  await client.execute(`
    CREATE TABLE IF NOT EXISTS proactive_profile_revisions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      profile_version TEXT NOT NULL DEFAULT 'full_profile_v1',
      revision INTEGER NOT NULL DEFAULT 1,
      device_id TEXT NOT NULL,
      desired_state TEXT NOT NULL DEFAULT 'none',
      status TEXT NOT NULL DEFAULT 'draft',
      full_access_required INTEGER NOT NULL DEFAULT 1,
      processing_boundary TEXT NOT NULL DEFAULT 'local_only',
      manifest_json TEXT NOT NULL DEFAULT '{}',
      grant_set_hash TEXT,
      confirmed_at TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // 设备级修订号允许不同设备各自从 1 开始；旧试验版索引缺少 device_id，先幂等重建。
  await client.execute(`DROP INDEX IF EXISTS proactive_profile_tenant_version_revision_idx;`);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS proactive_profile_tenant_version_revision_idx
    ON proactive_profile_revisions(workspace_id, subject_user_id, profile_version, device_id, revision);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_profile_tenant_device_idx
    ON proactive_profile_revisions(workspace_id, subject_user_id, device_id, status);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_profile_active_idx
    ON proactive_profile_revisions(workspace_id, subject_user_id, status);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS proactive_source_grants (
      id TEXT PRIMARY KEY,
      revision_id TEXT NOT NULL REFERENCES proactive_profile_revisions(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      purpose TEXT NOT NULL,
      scope TEXT NOT NULL,
      os_capability TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'requested',
      mandatory INTEGER NOT NULL DEFAULT 1,
      processing_boundary TEXT NOT NULL DEFAULT 'local_only',
      grant_version INTEGER NOT NULL DEFAULT 1,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      granted_at TEXT,
      revoked_at TEXT,
      last_verified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS proactive_source_revision_source_purpose_idx
    ON proactive_source_grants(revision_id, source_key, purpose);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_source_tenant_state_idx
    ON proactive_source_grants(workspace_id, subject_user_id, state);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_source_tenant_source_idx
    ON proactive_source_grants(workspace_id, subject_user_id, source_key);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS proactive_activation_leases (
      id TEXT PRIMARY KEY,
      revision_id TEXT NOT NULL REFERENCES proactive_profile_revisions(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      epoch TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      local_ready INTEGER NOT NULL DEFAULT 0,
      full_access_snapshot INTEGER NOT NULL DEFAULT 0,
      issued_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS proactive_activation_tenant_device_epoch_idx
    ON proactive_activation_leases(workspace_id, subject_user_id, device_id, epoch);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_activation_tenant_active_idx
    ON proactive_activation_leases(workspace_id, subject_user_id, device_id, status);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS proactive_captures (
      id TEXT PRIMARY KEY,
      revision_id TEXT NOT NULL REFERENCES proactive_profile_revisions(id) ON DELETE CASCADE,
      source_grant_id TEXT NOT NULL REFERENCES proactive_source_grants(id) ON DELETE RESTRICT,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      content_type TEXT NOT NULL,
      payload_text TEXT,
      payload_json TEXT,
      checksum TEXT NOT NULL,
      byte_size INTEGER NOT NULL DEFAULT 0,
      processing_boundary TEXT NOT NULL DEFAULT 'local_only',
      observed_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      retention_until TEXT NOT NULL,
      distillation_status TEXT NOT NULL DEFAULT 'pending',
      distillation_attempt_count INTEGER NOT NULL DEFAULT 0,
      last_distillation_error TEXT,
      retention_blocked_at TEXT,
      distilled_at TEXT,
      distilled_memory_ids_json TEXT NOT NULL DEFAULT '[]',
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_capture_tenant_observed_idx
    ON proactive_captures(workspace_id, subject_user_id, observed_at);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_capture_tenant_retention_idx
    ON proactive_captures(workspace_id, subject_user_id, retention_until, distillation_status);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_capture_revision_idx ON proactive_captures(revision_id);
  `);
  // CAP-033 增量迁移：允许从早期试验版主动表升级到带 retention blocked / attempt 账本的版本。
  await addColumnIfMissing(client, "proactive_captures", "distillation_attempt_count", "distillation_attempt_count INTEGER NOT NULL DEFAULT 0");
  await addColumnIfMissing(client, "proactive_captures", "last_distillation_error", "last_distillation_error TEXT");
  await addColumnIfMissing(client, "proactive_captures", "retention_blocked_at", "retention_blocked_at TEXT");

  await client.execute(`
    CREATE TABLE IF NOT EXISTS proactive_observations (
      id TEXT PRIMARY KEY,
      revision_id TEXT NOT NULL REFERENCES proactive_profile_revisions(id) ON DELETE CASCADE,
      source_grant_id TEXT NOT NULL REFERENCES proactive_source_grants(id) ON DELETE RESTRICT,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      source_key TEXT NOT NULL,
      observation_type TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      checksum TEXT NOT NULL,
      processing_boundary TEXT NOT NULL DEFAULT 'local_only',
      algorithm_version TEXT NOT NULL DEFAULT 'local-observation-v1',
      observed_at TEXT NOT NULL,
      normalized_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_observation_tenant_observed_idx
    ON proactive_observations(workspace_id, subject_user_id, observed_at);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_observation_revision_idx ON proactive_observations(revision_id);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_observation_source_idx ON proactive_observations(source_grant_id);
  `);

  await client.execute(`
    CREATE TABLE IF NOT EXISTS proactive_profile_claims (
      id TEXT PRIMARY KEY,
      revision_id TEXT NOT NULL REFERENCES proactive_profile_revisions(id) ON DELETE CASCADE,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      claim_type TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      content TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'inferred',
      confidence INTEGER NOT NULL DEFAULT 0,
      algorithm_version TEXT NOT NULL DEFAULT 'local-profile-v1',
      processing_boundary TEXT NOT NULL DEFAULT 'local_only',
      evidence_capture_ids_json TEXT NOT NULL DEFAULT '[]',
      evidence_refs_json TEXT NOT NULL DEFAULT '[]',
      source_grant_ids_json TEXT NOT NULL DEFAULT '[]',
      first_observed_at TEXT,
      last_observed_at TEXT,
      confirmed_at TEXT,
      rejected_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_claim_tenant_state_idx
    ON proactive_profile_claims(workspace_id, subject_user_id, state);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_claim_tenant_type_idx
    ON proactive_profile_claims(workspace_id, subject_user_id, claim_type);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_claim_revision_idx ON proactive_profile_claims(revision_id);
  `);
  await addColumnIfMissing(client, "proactive_profile_claims", "algorithm_version", "algorithm_version TEXT NOT NULL DEFAULT 'local-profile-v1'");
  await addColumnIfMissing(client, "proactive_profile_claims", "first_observed_at", "first_observed_at TEXT");
  await addColumnIfMissing(client, "proactive_profile_claims", "last_observed_at", "last_observed_at TEXT");

  await client.execute(`
    CREATE TABLE IF NOT EXISTS proactive_actions (
      id TEXT PRIMARY KEY,
      revision_id TEXT NOT NULL REFERENCES proactive_profile_revisions(id) ON DELETE CASCADE,
      activation_lease_id TEXT REFERENCES proactive_activation_leases(id) ON DELETE SET NULL,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target TEXT NOT NULL,
      request_json TEXT NOT NULL DEFAULT '{}',
      authorization_scope TEXT NOT NULL,
      action_grant_revision TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      requested_by TEXT NOT NULL,
      approved_by TEXT,
      approved_at TEXT,
      reversible INTEGER NOT NULL DEFAULT 1,
      external INTEGER NOT NULL DEFAULT 0,
      started_at TEXT,
      finished_at TEXT,
      outcome_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_action_tenant_state_idx
    ON proactive_actions(workspace_id, subject_user_id, state);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_action_tenant_created_idx
    ON proactive_actions(workspace_id, subject_user_id, created_at);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_action_revision_idx ON proactive_actions(revision_id);
  `);
  await addColumnIfMissing(client, "proactive_actions", "action_grant_revision", "action_grant_revision TEXT NOT NULL DEFAULT 'legacy-v1'");

  await client.execute(`
    CREATE TABLE IF NOT EXISTS proactive_audit_events (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      subject_user_id TEXT NOT NULL,
      revision_id TEXT REFERENCES proactive_profile_revisions(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      processing_boundary TEXT NOT NULL DEFAULT 'local_only',
      occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_audit_tenant_occurred_idx
    ON proactive_audit_events(workspace_id, subject_user_id, occurred_at);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS proactive_audit_resource_idx
    ON proactive_audit_events(resource_type, resource_id);
  `);

  // CAP-033 intelligence suite + CAP-034 Home Assistant + CAP-035 Xiaomi Health.
  const proactiveIntelligenceDdl = [
    `CREATE TABLE IF NOT EXISTS proactive_timeline_events (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, source_grant_id TEXT, source_key TEXT NOT NULL,
      event_type TEXT NOT NULL, subject_key TEXT NOT NULL, title TEXT NOT NULL, summary TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}', privacy_class TEXT NOT NULL DEFAULT 'private',
      project_id TEXT, relationship_id TEXT, checksum TEXT NOT NULL,
      processing_boundary TEXT NOT NULL DEFAULT 'local_only', occurred_at TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS proactive_timeline_tenant_checksum_idx
      ON proactive_timeline_events(workspace_id, subject_user_id, checksum);`,
    `CREATE INDEX IF NOT EXISTS proactive_timeline_tenant_occurred_idx
      ON proactive_timeline_events(workspace_id, subject_user_id, occurred_at);`,
    `CREATE INDEX IF NOT EXISTS proactive_timeline_tenant_subject_idx
      ON proactive_timeline_events(workspace_id, subject_user_id, subject_key);`,
    `CREATE TABLE IF NOT EXISTS proactive_projects (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, title TEXT NOT NULL, objective TEXT, description TEXT,
      status TEXT NOT NULL DEFAULT 'active', priority INTEGER NOT NULL DEFAULT 50,
      confidence INTEGER NOT NULL DEFAULT 0, due_at TEXT, last_activity_at TEXT,
      source_timeline_ids_json TEXT NOT NULL DEFAULT '[]', processing_boundary TEXT NOT NULL DEFAULT 'local_only',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE INDEX IF NOT EXISTS proactive_project_tenant_status_idx
      ON proactive_projects(workspace_id, subject_user_id, status);`,
    `CREATE TABLE IF NOT EXISTS proactive_relationships (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, relationship_type TEXT NOT NULL DEFAULT 'contact', display_name TEXT NOT NULL,
      notes TEXT, state TEXT NOT NULL DEFAULT 'active', confidence INTEGER NOT NULL DEFAULT 0,
      last_interaction_at TEXT, source_grant_ids_json TEXT NOT NULL DEFAULT '[]',
      processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE INDEX IF NOT EXISTS proactive_relationship_tenant_state_idx
      ON proactive_relationships(workspace_id, subject_user_id, state);`,
    `CREATE TABLE IF NOT EXISTS proactive_commitments (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, project_id TEXT, relationship_id TEXT, content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', importance INTEGER NOT NULL DEFAULT 50,
      due_at TEXT, source_timeline_id TEXT, processing_boundary TEXT NOT NULL DEFAULT 'local_only',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE INDEX IF NOT EXISTS proactive_commitment_tenant_due_idx
      ON proactive_commitments(workspace_id, subject_user_id, status, due_at);`,
    `CREATE TABLE IF NOT EXISTS proactive_workflow_templates (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT,
      state TEXT NOT NULL DEFAULT 'candidate', trigger_json TEXT NOT NULL DEFAULT '{}',
      steps_json TEXT NOT NULL DEFAULT '[]', evidence_count INTEGER NOT NULL DEFAULT 1,
      success_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0,
      last_observed_at TEXT, processing_boundary TEXT NOT NULL DEFAULT 'local_only',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE INDEX IF NOT EXISTS proactive_workflow_tenant_state_idx
      ON proactive_workflow_templates(workspace_id, subject_user_id, state);`,
    `CREATE TABLE IF NOT EXISTS proactive_trigger_rules (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, name TEXT NOT NULL, trigger_type TEXT NOT NULL,
      condition_json TEXT NOT NULL DEFAULT '{}', action_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 0,
      cooldown_seconds INTEGER NOT NULL DEFAULT 3600, quiet_hours_json TEXT NOT NULL DEFAULT '{}',
      last_triggered_at TEXT, processing_boundary TEXT NOT NULL DEFAULT 'local_only',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE INDEX IF NOT EXISTS proactive_trigger_rule_tenant_enabled_idx
      ON proactive_trigger_rules(workspace_id, subject_user_id, enabled);`,
    `CREATE TABLE IF NOT EXISTS proactive_trigger_events (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, rule_id TEXT, trigger_type TEXT NOT NULL, cause_json TEXT NOT NULL DEFAULT '{}',
      decision TEXT NOT NULL, reason TEXT, action_id TEXT, occurred_at TEXT NOT NULL,
      processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL);`,
    `CREATE INDEX IF NOT EXISTS proactive_trigger_event_tenant_occurred_idx
      ON proactive_trigger_events(workspace_id, subject_user_id, occurred_at);`,
    `CREATE TABLE IF NOT EXISTS proactive_action_verifications (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      action_id TEXT NOT NULL, expected_json TEXT NOT NULL DEFAULT '{}', observed_json TEXT,
      status TEXT NOT NULL DEFAULT 'pending', attempt_count INTEGER NOT NULL DEFAULT 0,
      verified_at TEXT, error TEXT, processing_boundary TEXT NOT NULL DEFAULT 'local_only',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS proactive_action_verification_tenant_action_idx
      ON proactive_action_verifications(workspace_id, subject_user_id, action_id);`,
    `CREATE TABLE IF NOT EXISTS proactive_claim_conflicts (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, primary_claim_id TEXT NOT NULL, conflicting_claim_id TEXT NOT NULL,
      reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', resolution TEXT, resolved_at TEXT,
      processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS proactive_claim_conflict_pair_idx
      ON proactive_claim_conflicts(primary_claim_id, conflicting_claim_id);`,
    `CREATE TABLE IF NOT EXISTS proactive_preparation_bundles (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, project_id TEXT, commitment_id TEXT, title TEXT NOT NULL,
      bundle_json TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'ready', available_at TEXT NOT NULL,
      expires_at TEXT, processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE INDEX IF NOT EXISTS proactive_preparation_tenant_available_idx
      ON proactive_preparation_bundles(workspace_id, subject_user_id, status, available_at);`,
    `CREATE TABLE IF NOT EXISTS proactive_attention_states (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, window_start TEXT NOT NULL, window_end TEXT NOT NULL,
      focus_score INTEGER NOT NULL, fatigue_score INTEGER NOT NULL, context_switches INTEGER NOT NULL DEFAULT 0,
      error_signals INTEGER NOT NULL DEFAULT 0, recommendation TEXT, evidence_json TEXT NOT NULL DEFAULT '[]',
      processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE INDEX IF NOT EXISTS proactive_attention_tenant_window_idx
      ON proactive_attention_states(workspace_id, subject_user_id, window_end);`,
    `CREATE TABLE IF NOT EXISTS proactive_drift_signals (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, signal_type TEXT NOT NULL, project_id TEXT,
      expected_json TEXT NOT NULL DEFAULT '{}', actual_json TEXT NOT NULL DEFAULT '{}', severity INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'open', explanation TEXT, detected_at TEXT NOT NULL,
      processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE INDEX IF NOT EXISTS proactive_drift_tenant_state_idx
      ON proactive_drift_signals(workspace_id, subject_user_id, state);`,
    `CREATE TABLE IF NOT EXISTS proactive_scene_snapshots (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, scene_type TEXT NOT NULL, application_id TEXT,
      payload_json TEXT NOT NULL DEFAULT '{}', checksum TEXT NOT NULL, captured_at TEXT NOT NULL,
      processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS proactive_scene_tenant_checksum_idx
      ON proactive_scene_snapshots(workspace_id, subject_user_id, checksum);`,
    `CREATE TABLE IF NOT EXISTS proactive_review_reports (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, period_type TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL,
      summary TEXT NOT NULL, metrics_json TEXT NOT NULL DEFAULT '{}', recommendations_json TEXT NOT NULL DEFAULT '[]',
      processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS proactive_review_tenant_period_idx
      ON proactive_review_reports(workspace_id, subject_user_id, period_type, period_start, period_end);`,
    `CREATE TABLE IF NOT EXISTS proactive_external_connections (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      revision_id TEXT NOT NULL, provider TEXT NOT NULL, display_name TEXT NOT NULL, endpoint TEXT,
      auth_type TEXT NOT NULL, credential_json TEXT NOT NULL DEFAULT '{}', scopes_json TEXT NOT NULL DEFAULT '[]',
      settings_json TEXT NOT NULL DEFAULT '{}', state TEXT NOT NULL DEFAULT 'active', last_sync_at TEXT,
      last_error TEXT, processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE INDEX IF NOT EXISTS proactive_connection_tenant_provider_idx
      ON proactive_external_connections(workspace_id, subject_user_id, provider, state);`,
    `CREATE TABLE IF NOT EXISTS proactive_home_entities (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      entity_id TEXT NOT NULL, domain TEXT NOT NULL, display_name TEXT, device_class TEXT,
      allowed_ops_json TEXT NOT NULL DEFAULT '[]', state_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 0,
      sensitive INTEGER NOT NULL DEFAULT 0, last_seen_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS proactive_home_connection_entity_idx
      ON proactive_home_entities(connection_id, entity_id);`,
    `CREATE TABLE IF NOT EXISTS proactive_health_samples (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL,
      metric TEXT NOT NULL, local_date TEXT NOT NULL, value INTEGER NOT NULL, unit TEXT NOT NULL,
      sensitivity TEXT NOT NULL DEFAULT 'low', source TEXT NOT NULL DEFAULT 'xiaomi_health',
      metadata_json TEXT NOT NULL DEFAULT '{}', observed_at TEXT NOT NULL,
      processing_boundary TEXT NOT NULL DEFAULT 'local_only', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`,
    `CREATE UNIQUE INDEX IF NOT EXISTS proactive_health_tenant_metric_date_idx
      ON proactive_health_samples(workspace_id, subject_user_id, connection_id, metric, local_date);`,
  ];
  for (const ddl of proactiveIntelligenceDdl) await client.execute(ddl);
}

/**
 * 初始化 RecoveryControlLedger 独立 deny 账本（独立故障域）。
 *
 * 必须使用独立的 libsql client / 数据库文件，与业务库分离凭据与故障域（PRD §8 数据规则）。
 * 调用方负责传入专用 client，不得复用 initDatabaseSchema 的业务连接。
 */
export async function initLedgerSchema(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS recovery_control_ledger (
      event_id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      event_type TEXT NOT NULL,
      workspace_ref TEXT,
      subject_ref TEXT,
      target_ref TEXT,
      occurred_at TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      tamper_evidence TEXT
    );
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS recovery_ledger_idempotency_idx ON recovery_control_ledger(idempotency_key);
  `);
  await client.execute(`
    CREATE INDEX IF NOT EXISTS recovery_ledger_sequence_idx ON recovery_control_ledger(sequence);
  `);
}
