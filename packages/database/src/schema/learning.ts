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

/** 每次答题的不可变记录（掌握度是其派生结果，不反向覆盖事实）
 * CAP-016 扩展：难度等级、提示使用次数、耗时
 */
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
    /** CAP-016：难度等级 1-5 */
    difficulty: integer("difficulty"),
    /** CAP-016：提示使用次数 */
    hintCount: integer("hint_count").notNull().default(0),
    /** CAP-016：耗时（秒） */
    timeSpentSec: integer("time_spent_sec"),
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

/** 用户对派生错题的处置；不修改不可变的 QuestionAttempt。 */
export const mistakeDispositions = sqliteTable(
  "mistake_dispositions",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    questionId: text("question_id").notNull().references(() => questions.id),
    status: text("status").notNull().default("active"), // "active" | "dismissed"
    reason: text("reason"), // 错因标签（用户标注的错误原因）
    note: text("note"), // 用户备注
    ...timestampColumns,
  },
  (table) => ({
    tenantQuestionIdx: uniqueIndex("mistake_dispositions_tenant_question_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.questionId,
    ),
  }),
);

/** 用户为派生错题添加的错因元数据；不得修改 QuestionAttempt 学习事实。 */
export const mistakeInsights = sqliteTable(
  "mistake_insights",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    questionId: text("question_id").notNull().references(() => questions.id),
    reasonCode: text("reason_code").notNull(), // concept_gap | calculation | careless | misread | other
    note: text("note"),
    ...timestampColumns,
  },
  (table) => ({
    tenantQuestionIdx: uniqueIndex("mistake_insights_tenant_question_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.questionId,
    ),
  }),
);

/** 一次短时练习的范围与结束状态；作答事实仍单独保存在 questionAttempts。 */
export const practiceSessions = sqliteTable(
  "practice_sessions",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    questionCount: integer("question_count").notNull(),
    questionIds: text("question_ids", { mode: "json" }).notNull(),
    status: text("status").notNull().default("active"), // "active" | "completed"
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
  },
  (table) => ({
    tenantIdx: index("practice_sessions_tenant_idx").on(table.workspaceId, table.subjectUserId),
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
    timezoneSnapshot: text("timezone_snapshot").notNull().default("UTC"),
    status: text("status").notNull().default("active"), // "active" | "completed" | "dismissed" | "archived"
    completionIsCorrect: integer("completion_is_correct", { mode: "boolean" }),
    nextReviewId: text("next_review_id"),
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

/**
 * 思维宇宙知识关系（P1 · CAP-015；知识网络边）
 *
 * CAP-015 扩展：纠正状态、合并/拆分追踪、软删除。
 * 被纠正的关系立即停止用于讲解和推荐。
 */
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
    /** CAP-015：纠正状态 — corrected 关系停止用于讲解和推荐 */
    correctionStatus: text("correction_status").notNull().default("active"), // "active" | "corrected" | "merged" | "split" | "deleted"
    /** CAP-015：纠正原因 */
    correctionReason: text("correction_reason"),
    /** CAP-015：合并目标（合并到哪条关系） */
    mergedInto: text("merged_into"),
    /** CAP-015：软删除 */
    deletedAt: text("deleted_at"),
    ...timestampColumns,
  },
  (table) => ({
    tenantFromIdx: index("knowledge_relations_tenant_from_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.fromKnowledgeId,
    ),
    correctionIdx: index("knowledge_relations_correction_idx").on(table.correctionStatus),
  }),
);

// ============ CAP-016 自适应刷题与报告 ============

/**
 * 练习报告（CAP-016）
 *
 * 报告区分观测（正确率/耗时/提示次数）与推断（掌握度预测/偏差评估）。
 * 用户可重置推断但保留原始作答记录。
 */
export const practiceReports = sqliteTable(
  "practice_reports",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    /** → practice_sessions.id */
    sessionId: text("session_id").notNull(),
    /** 观测：总题数 */
    totalQuestions: integer("total_questions").notNull().default(0),
    /** 观测：正确数 */
    correctCount: integer("correct_count").notNull().default(0),
    /** 观测：错误数 */
    incorrectCount: integer("incorrect_count").notNull().default(0),
    /** 观测：平均耗时（秒） */
    avgTimeSpentSec: integer("avg_time_spent_sec"),
    /** 观测：提示使用总次数 */
    totalHintsUsed: integer("total_hints_used").notNull().default(0),
    /** 推断：掌握度预测 0-1 */
    masteryPrediction: real("mastery_prediction"),
    /** 推断：偏差评估（如高估/低估） */
    biasAssessment: text("bias_assessment"),
    /** 报告类型：区分观测与推断 */
    reportType: text("report_type").notNull().default("summary"), // "summary" | "detailed" | "reset"
    /** 是否为重置后的推断（保留原始作答） */
    isReset: integer("is_reset", { mode: "boolean" }).notNull().default(false),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("practice_reports_tenant_idx").on(table.workspaceId, table.subjectUserId),
    sessionIdx: index("practice_reports_session_idx").on(table.sessionId),
  }),
);

// ============ CAP-017 学习规划（里程碑 + 任务路线图，参考 OpenMAIC PBL planner） ============

/**
 * 学习规划（CAP-017 重构）
 *
 * 由单次 LLM 结构化生成的学习路线图：主题 → 里程碑 → 任务。
 * 任务勾选驱动里程碑推进（全部任务完成 → 里程碑 completed，下一里程碑 active）。
 */
export const learningPlans = sqliteTable(
  "learning_plans",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    /** 用户输入的学习主题 */
    topic: text("topic").notNull(),
    /** 学习水平："beginner" | "intermediate" | "advanced" */
    level: text("level").notNull().default("beginner"),
    /** 规划标题（AI 生成） */
    title: text("title").notNull(),
    /** 规划描述（AI 生成，说明学习产出） */
    description: text("description").notNull(),
    /** 学习目标（AI 生成，掌握的能力） */
    learningObjective: text("learning_objective").notNull(),
    /** 能力收获（AI 生成，3-5 条学习者视角短语） */
    gains: text("gains", { mode: "json" }).notNull().default([]),
    /** 每日可用时间（分钟，生成输入快照） */
    dailyAvailableMinutes: integer("daily_available_minutes").notNull().default(25),
    /** 规划状态 */
    status: text("status").notNull().default("active"), // "active" | "archived"
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("learning_plans_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);

/** 规划里程碑（学习阶段） */
export const planMilestones = sqliteTable(
  "plan_milestones",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    /** → learning_plans.id */
    planId: text("plan_id")
      .notNull()
      .references(() => learningPlans.id, { onDelete: "cascade" }),
    /** 里程碑序号（从 0 开始） */
    order: integer("sort_order").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    /** 开场引导（这一阶段要做什么） */
    briefing: text("briefing"),
    /** 完成标准（怎样算走完这一阶段） */
    completionCriteria: text("completion_criteria"),
    /** 阶段收尾（完成后说什么） */
    debrief: text("debrief"),
    /** 里程碑状态（locked 随前置里程碑完成推进为 active） */
    status: text("status").notNull().default("active"), // "locked" | "active" | "completed"
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("plan_milestones_tenant_idx").on(table.workspaceId, table.subjectUserId),
    planIdx: index("plan_milestones_plan_idx").on(table.planId),
  }),
);

/** 里程碑下的具体任务 */
export const planTasks = sqliteTable(
  "plan_tasks",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    /** → plan_milestones.id */
    milestoneId: text("milestone_id")
      .notNull()
      .references(() => planMilestones.id, { onDelete: "cascade" }),
    /** 任务序号（里程碑内从 0 开始） */
    order: integer("sort_order").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    /** 提示（引导不代做） */
    hints: text("hints", { mode: "json" }).notNull().default([]),
    /** 任务状态 */
    status: text("status").notNull().default("todo"), // "todo" | "done"
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("plan_tasks_tenant_idx").on(table.workspaceId, table.subjectUserId),
    milestoneIdx: index("plan_tasks_milestone_idx").on(table.milestoneId),
  }),
);
