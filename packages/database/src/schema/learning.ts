/**
 * Aervox｜思隅 @aervox/database — 学习/练习/复习实体表
 *
 * 规则依据：docs/reference/PRD.md §8 数据模型（LearningGoal / Question / QuestionAttempt / KnowledgeItem / ReviewItem）
 */
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { tenantColumns, timestampColumns } from "./common.js";

/** 学习目标（CAP-002） */
export const learningGoals = sqliteTable(
  "learning_goals",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    topic: text("topic").notNull(),
    level: text("level").notNull().default("beginner"), // "beginner" | "intermediate" | "advanced"
    availableMinutes: integer("available_minutes").notNull().default(0),
    status: text("status").notNull().default("active"), // "active" | "paused" | "completed" | "archived"
    idempotencyKey: text("idempotency_key"),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("learning_goals_tenant_idx").on(table.workspaceId, table.subjectUserId),
    tenantIdempotencyIdx: uniqueIndex("learning_goals_tenant_idempotency_idx")
      .on(table.workspaceId, table.subjectUserId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  }),
);

/** 题目统一身份（生成/导入/人工；来源经 SourceArtifact 关联） */
export const questions = sqliteTable(
  "questions",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    sourceArtifactId: text("source_artifact_id"), // → source_artifacts.id（应用层维护，来源未落库前允许为空）
    knowledgeId: text("knowledge_id").references(() => knowledgeItems.id),
    prompt: text("prompt").notNull(),
    answerSpec: text("answer_spec", { mode: "json" }).notNull(),
    status: text("status").notNull().default("active"), // "draft" | "active" | "archived"
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("questions_tenant_idx").on(table.workspaceId, table.subjectUserId),
    sourceIdx: index("questions_source_artifact_idx").on(table.sourceArtifactId),
    knowledgeIdx: index("questions_knowledge_idx").on(table.knowledgeId),
  }),
);

/** 每次答题的不可变记录（掌握度是其派生结果，不反向覆盖事实） */
export const questionAttempts = sqliteTable(
  "question_attempts",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    sessionId: text("session_id").notNull(), // 会话标识（学习事实不可随会话删除级联）
    questionId: text("question_id")
      .notNull()
      .references(() => questions.id), // NO ACTION：保护不可变事实
    answer: text("answer").notNull(),
    judgement: text("judgement").notNull(), // "correct" | "incorrect" | "partial" | "unverifiable"
    evidence: text("evidence", { mode: "json" }),
    idempotencyKey: text("idempotency_key"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    sessionQuestionIdx: index("question_attempts_session_question_idx").on(
      table.sessionId,
      table.questionId,
    ),
    tenantIdx: index("question_attempts_tenant_idx").on(table.workspaceId, table.subjectUserId),
    tenantQuestionIdempotencyIdx: uniqueIndex("question_attempts_tenant_question_idempotency_idx")
      .on(table.workspaceId, table.subjectUserId, table.questionId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  }),
);

/** 用户可见知识点（明确区分观察结果 sourceStatus 与算法推断 masteryBasis） */
export const knowledgeItems = sqliteTable(
  "knowledge_items",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    concept: text("concept").notNull(),
    sourceStatus: text("source_status").notNull().default("inferred"), // "observed" | "inferred" | "verified"
    masteryState: text("mastery_state").notNull().default("unknown"), // "unknown" | "learning" | "reviewing" | "mastered"
    correctCount: integer("correct_count").notNull().default(0),
    wrongCount: integer("wrong_count").notNull().default(0),
    correctStreak: integer("correct_streak").notNull().default(0),
    mastery: real("mastery").notNull().default(0),
    masteryBasis: text("mastery_basis", { mode: "json" }), // 掌握度派生依据快照
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("knowledge_items_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);

/** 间隔复习调度项（CAP-006；同一租户/主体/知识点的活动项唯一） */
export const reviewItems = sqliteTable(
  "review_items",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    knowledgeId: text("knowledge_id")
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: "cascade" }),
    dueAt: text("due_at").notNull(),
    intervalDays: integer("interval_days").notNull().default(1),
    schedulerVersion: integer("scheduler_version").notNull().default(1),
    status: text("status").notNull().default("active"), // "active" | "completed" | "dismissed" | "archived"
    ...timestampColumns,
  },
  (table) => ({
    tenantKnowledgeActiveIdx: uniqueIndex("review_items_tenant_knowledge_active_idx")
      .on(table.workspaceId, table.subjectUserId, table.knowledgeId)
      .where(sql`${table.status} = 'active'`),
    tenantDueIdx: index("review_items_tenant_due_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.dueAt,
    ),
  }),
);

/** 思维宇宙知识关系（P1 · CAP-015；知识网络边） */
export const knowledgeRelations = sqliteTable(
  "knowledge_relations",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    fromKnowledgeId: text("from_knowledge_id")
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: "cascade" }),
    toKnowledgeId: text("to_knowledge_id")
      .notNull()
      .references(() => knowledgeItems.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull(), // "prerequisite" | "related" | "contrast" | "causal"
    source: text("source").notNull().default("inference"), // "user" | "inference" | "external" | "system"
    confidence: integer("confidence").notNull().default(0),
    ...timestampColumns,
  },
  (table) => ({
    tenantFromIdx: index("knowledge_relations_tenant_from_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.fromKnowledgeId,
    ),
  }),
);
