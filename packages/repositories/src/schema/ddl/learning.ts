/**
 * Aervox｜思隅 @aervox/repositories — learning 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";
import { addColumnIfMissing } from "./common.js";

export async function createLearningTables(client: Client): Promise<void> {
  // 6. 学习/练习/复习域（PRD §8）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS learning_goals (
        id TEXT PRIMARY KEY,
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
      CREATE UNIQUE INDEX IF NOT EXISTS learning_goals_local_idempotency_idx
      ON learning_goals(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS questions (
        id TEXT PRIMARY KEY,
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
      CREATE INDEX IF NOT EXISTS questions_source_artifact_idx ON questions(source_artifact_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS questions_knowledge_idx ON questions(knowledge_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS question_attempts (
        id TEXT PRIMARY KEY,
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
  await client.execute(`DROP INDEX IF EXISTS question_attempts_local_idempotency_idx;`);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS question_attempts_local_question_idempotency_idx
      ON question_attempts(question_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS mistake_dispositions (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL REFERENCES questions(id),
        status TEXT NOT NULL DEFAULT 'active',
        reason TEXT,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(question_id)
      );
    `);
  await addColumnIfMissing(client, "mistake_dispositions", "reason", "reason TEXT");
  await addColumnIfMissing(client, "mistake_dispositions", "note", "note TEXT");
  await client.execute(`
      CREATE TABLE IF NOT EXISTS mistake_insights (
        id TEXT PRIMARY KEY,
        question_id TEXT NOT NULL REFERENCES questions(id),
        reason_code TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(question_id)
      );
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS practice_sessions (
        id TEXT PRIMARY KEY,
        question_count INTEGER NOT NULL,
        question_ids TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'active',
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
    `);
  await addColumnIfMissing(client, "practice_sessions", "question_ids", "question_ids TEXT NOT NULL DEFAULT '[]'");
  // CAP-016：练习报告
    await client.execute(`
      CREATE TABLE IF NOT EXISTS practice_reports (
        id TEXT PRIMARY KEY,
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
      CREATE INDEX IF NOT EXISTS practice_reports_session_idx ON practice_reports(session_id);
    `);
  // CAP-017：学习规划（里程碑 + 任务路线图）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS learning_plans (
        id TEXT PRIMARY KEY,
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
      CREATE TABLE IF NOT EXISTS plan_milestones (
        id TEXT PRIMARY KEY,
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
      CREATE INDEX IF NOT EXISTS plan_milestones_plan_idx ON plan_milestones(plan_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS plan_tasks (
        id TEXT PRIMARY KEY,
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
      CREATE INDEX IF NOT EXISTS plan_tasks_milestone_idx ON plan_tasks(milestone_id);
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS knowledge_items (
        id TEXT PRIMARY KEY,
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
      CREATE TABLE IF NOT EXISTS review_items (
        id TEXT PRIMARY KEY,
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
      CREATE UNIQUE INDEX IF NOT EXISTS review_items_local_knowledge_active_idx ON review_items(knowledge_id) WHERE status = 'active';
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS review_items_local_due_idx ON review_items(due_at);
    `);
  await addColumnIfMissing(client, "review_items", "completion_is_correct", "completion_is_correct INTEGER");
  await addColumnIfMissing(client, "review_items", "next_review_id", "next_review_id TEXT");
  await addColumnIfMissing(client, "review_items", "timezone_snapshot", "timezone_snapshot TEXT NOT NULL DEFAULT 'UTC'");
  await client.execute(`
      CREATE TABLE IF NOT EXISTS knowledge_relations (
        id TEXT PRIMARY KEY,
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
      CREATE INDEX IF NOT EXISTS knowledge_relations_local_from_idx ON knowledge_relations(from_knowledge_id);
    `);
  // CAP-015：扩展知识关系表（纠正状态、合并/拆分、软删除）
    await addColumnIfMissing(client, "knowledge_relations", "correction_status", "correction_status TEXT NOT NULL DEFAULT 'active'");
  await addColumnIfMissing(client, "knowledge_relations", "correction_reason", "correction_reason TEXT");
  await addColumnIfMissing(client, "knowledge_relations", "merged_into", "merged_into TEXT");
  await addColumnIfMissing(client, "knowledge_relations", "deleted_at", "deleted_at TEXT");
  await client.execute(`
      CREATE INDEX IF NOT EXISTS knowledge_relations_correction_idx ON knowledge_relations(correction_status);
    `);
}
