/**
 * Aervox｜思隅 @aervox/repositories — learning 仓储类型（自 types.ts 机械拆分）
 */
import type { KnowledgeItemModel, LearningGoalModel, MistakeItemModel, PracticeSessionModel, QuestionAttemptModel, QuestionModel, ReviewItemModel } from "./user-question.js";
import type { LocalContext } from "../../local-context.js";

export interface ILearningRepository {
  createLearningGoal(
    tenant: LocalContext,
    goal: {
      id: string;
      topic: string;
      level?: string;
      availableMinutes?: number;
      status?: string;
      idempotencyKey?: string | null;
    },
  ): Promise<LearningGoalModel>;
  createLearningGoalIdempotent(
    tenant: LocalContext,
    goal: {
      id: string;
      topic: string;
      level?: string;
      availableMinutes?: number;
      idempotencyKey: string;
    },
  ): Promise<{ goal: LearningGoalModel; created: boolean }>;
  getLearningGoal(tenant: LocalContext, id: string): Promise<LearningGoalModel | null>;
  listLearningGoals(tenant: LocalContext, includeArchived?: boolean): Promise<LearningGoalModel[]>;
  updateLearningGoal(
    tenant: LocalContext,
    id: string,
    goal: { topic?: string; level?: string; availableMinutes?: number; status?: string },
  ): Promise<LearningGoalModel | null>;
  createQuestion(
    tenant: LocalContext,
    question: {
      id: string;
      prompt: string;
      answerSpec: unknown;
      sourceArtifactId?: string | null;
      knowledgeId?: string | null;
    },
  ): Promise<QuestionModel>;
  getQuestion(tenant: LocalContext, id: string): Promise<QuestionModel | null>;
  listActiveQuestions(tenant: LocalContext, limit: number): Promise<QuestionModel[]>;
  createPracticeSession(
    tenant: LocalContext,
    session: { id: string; questionCount: number; questionIds: string[] },
  ): Promise<PracticeSessionModel>;
  getPracticeSession(tenant: LocalContext, sessionId: string): Promise<PracticeSessionModel | null>;
  getLatestActivePracticeSession(tenant: LocalContext): Promise<PracticeSessionModel | null>;
  completePracticeSession(tenant: LocalContext, sessionId: string): Promise<PracticeSessionModel | null>;
  recordAttempt(
    tenant: LocalContext,
    attempt: {
      id: string;
      sessionId: string;
      questionId: string;
      answer: string;
      judgement: string;
      evidence?: unknown;
      idempotencyKey?: string | null;
      hintCount?: number;
      timeSpentSec?: number;
    },
  ): Promise<QuestionAttemptModel>;
  listAttemptsByQuestion(tenant: LocalContext, questionId: string): Promise<QuestionAttemptModel[]>;
  listAttemptsBySession(tenant: LocalContext, sessionId: string): Promise<QuestionAttemptModel[]>;
  listMistakes(
    tenant: LocalContext,
    status?: "active" | "mastered" | "dismissed" | "all",
  ): Promise<MistakeItemModel[]>;
  setMistakeDisposition(tenant: LocalContext, item: { id: string; questionId: string; status: "active" | "dismissed" }): Promise<void>;
  setMistakeInsight(
    tenant: LocalContext,
    item: { id: string; questionId: string; reasonCode: "concept_gap" | "calculation" | "careless" | "misread" | "other"; note?: string | null },
  ): Promise<void>;
  clearMistakeInsight(tenant: LocalContext, questionId: string): Promise<void>;
  getAttemptByIdempotencyKey(
    tenant: LocalContext,
    questionId: string,
    idempotencyKey: string,
  ): Promise<QuestionAttemptModel | null>;
  recordAttemptIdempotent(
    tenant: LocalContext,
    attempt: {
      id: string;
      sessionId: string;
      questionId: string;
      answer: string;
      judgement: string;
      evidence?: unknown;
      idempotencyKey: string;
      hintCount?: number;
      timeSpentSec?: number;
    },
  ): Promise<{ attempt: QuestionAttemptModel; created: boolean }>;
  createKnowledgeItem(
    tenant: LocalContext,
    item: {
      id: string;
      concept: string;
      sourceStatus?: string;
      masteryState?: string;
      correctCount?: number;
      wrongCount?: number;
      correctStreak?: number;
      mastery?: number;
    },
  ): Promise<KnowledgeItemModel>;
  getKnowledgeItem(tenant: LocalContext, id: string): Promise<KnowledgeItemModel | null>;
  updateMastery(tenant: LocalContext, id: string, masteryState: string, basis?: unknown): Promise<KnowledgeItemModel | null>;
  updatePracticeState(
    tenant: LocalContext,
    id: string,
    state: {
      correctCount: number;
      wrongCount: number;
      correctStreak: number;
      mastery: number;
      masteryState: string;
      masteryBasis: unknown;
    },
  ): Promise<KnowledgeItemModel | null>;
  scheduleReviewItem(
    tenant: LocalContext,
    item: { id: string; knowledgeId: string; dueAt: string; intervalDays: number; schedulerVersion?: number; timezoneSnapshot?: string },
  ): Promise<ReviewItemModel>;
  createReviewItem(
    tenant: LocalContext,
    item: { id: string; knowledgeId: string; dueAt: string; intervalDays?: number; schedulerVersion?: number; timezoneSnapshot?: string },
  ): Promise<ReviewItemModel>;
  getReviewItem(tenant: LocalContext, id: string): Promise<ReviewItemModel | null>;
  listCompletedReviewItems(tenant: LocalContext, limit?: number): Promise<ReviewItemModel[]>;
  completeReviewAndSchedule(
    tenant: LocalContext,
    data: {
      reviewId: string;
      knowledgeId: string;
      isCorrect: boolean;
      practiceState: {
        correctCount: number;
        wrongCount: number;
        correctStreak: number;
        mastery: number;
        masteryState: string;
        masteryBasis: unknown;
      };
      nextReview: { id: string; dueAt: string; intervalDays: number; schedulerVersion: number; timezoneSnapshot: string };
    },
  ): Promise<{ completed: ReviewItemModel; nextReview: ReviewItemModel; knowledge: KnowledgeItemModel } | null>;
  listDueReviewItems(tenant: LocalContext, before: string): Promise<ReviewItemModel[]>;
  completeReviewItem(tenant: LocalContext, id: string): Promise<ReviewItemModel | null>;
  // P1（R2 · CAP-015）：思维宇宙知识关系
  createKnowledgeRelation(
    tenant: LocalContext,
    relation: {
      id: string;
      fromKnowledgeId: string;
      toKnowledgeId: string;
      relationType: string;
      source?: string;
      confidence?: number;
    },
  ): Promise<KnowledgeRelationModel>;
  listKnowledgeRelations(tenant: LocalContext, knowledgeId: string): Promise<KnowledgeRelationModel[]>;
  /** CAP-015：获取关系详情 */
  getKnowledgeRelation(tenant: LocalContext, relationId: string): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：纠正关系 — corrected 状态停止用于讲解和推荐 */
  correctKnowledgeRelation(
    tenant: LocalContext,
    relationId: string,
    reason: string,
  ): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：合并两条关系 */
  mergeKnowledgeRelations(
    tenant: LocalContext,
    sourceRelationId: string,
    targetRelationId: string,
  ): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：拆分关系（标记为 split，可选创建新关系） */
  splitKnowledgeRelation(
    tenant: LocalContext,
    relationId: string,
    reason: string,
  ): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：软删除关系 */
  deleteKnowledgeRelation(tenant: LocalContext, relationId: string): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：获取知识图谱（仅 active 关系，用于讲解和推荐） */
  getActiveKnowledgeGraph(
    tenant: LocalContext,
    knowledgeId: string,
  ): Promise<KnowledgeRelationModel[]>;

  // ============ CAP-016 练习报告 ============

  /** CAP-016：创建练习报告 */
  createPracticeReport(
    tenant: LocalContext,
    input: {
      id: string;
      sessionId: string;
      totalQuestions: number;
      correctCount: number;
      incorrectCount: number;
      avgTimeSpentSec?: number;
      totalHintsUsed?: number;
      masteryPrediction?: number;
      biasAssessment?: string;
      reportType?: string;
    },
  ): Promise<PracticeReportModel>;
  /** CAP-016：获取练习报告 */
  getPracticeReport(tenant: LocalContext, reportId: string): Promise<PracticeReportModel | null>;
  /** CAP-016：按会话查询报告 */
  listPracticeReports(tenant: LocalContext, sessionId: string): Promise<PracticeReportModel[]>;
  /** CAP-016：重置推断（保留原始作答） */
  resetMasteryInference(
    tenant: LocalContext,
    sessionId: string,
  ): Promise<PracticeReportModel>;

  // ============ CAP-017 学习规划（里程碑 + 任务路线图） ============

  /** 创建学习规划（事务写入规划 + 里程碑 + 任务） */
  createLearningPlan(
    tenant: LocalContext,
    input: {
      id: string;
      topic: string;
      level?: string;
      title: string;
      description: string;
      learningObjective: string;
      gains?: string[];
      dailyAvailableMinutes?: number;
      milestones: Array<{
        id: string;
        title: string;
        description?: string;
        briefing?: string;
        completionCriteria?: string;
        debrief?: string;
        tasks: Array<{
          id: string;
          title: string;
          description?: string;
          hints?: string[];
        }>;
      }>;
    },
  ): Promise<LearningPlanModel>;
  /** 获取规划（聚合里程碑与任务） */
  getLearningPlan(tenant: LocalContext, planId: string): Promise<LearningPlanModel | null>;
  /** 列出规划 */
  listLearningPlans(tenant: LocalContext, includeArchived?: boolean): Promise<LearningPlanModel[]>;
  /** 更新任务状态并推进里程碑（任务全 done → 里程碑 completed + 下一里程碑 active） */
  setPlanTaskStatus(
    tenant: LocalContext,
    taskId: string,
    status: "todo" | "done",
  ): Promise<LearningPlanModel | null>;
  /** 归档规划 */
  archiveLearningPlan(tenant: LocalContext, planId: string): Promise<LearningPlanModel | null>;
}

export interface KnowledgeRelationModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  fromKnowledgeId: string;
  toKnowledgeId: string;
  relationType: string;
  source: string;
  confidence: number;
  /** CAP-015：纠正状态 */
  correctionStatus: string;
  /** CAP-015：纠正原因 */
  correctionReason?: string | null;
  /** CAP-015：合并目标 */
  mergedInto?: string | null;
  /** CAP-015：软删除 */
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeReportModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  sessionId: string;
  totalQuestions: number;
  correctCount: number;
  incorrectCount: number;
  avgTimeSpentSec?: number | null;
  totalHintsUsed: number;
  masteryPrediction?: number | null;
  biasAssessment?: string | null;
  reportType: string;
  isReset: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PlanTaskModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  milestoneId: string;
  order: number;
  title: string;
  description?: string | null;
  hints: string[];
  status: string; // "todo" | "done"
  createdAt: string;
  updatedAt: string;
}

export interface PlanMilestoneModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  planId: string;
  order: number;
  title: string;
  description?: string | null;
  briefing?: string | null;
  completionCriteria?: string | null;
  debrief?: string | null;
  status: string; // "locked" | "active" | "completed"
  tasks: PlanTaskModel[];
  createdAt: string;
  updatedAt: string;
}

export interface LearningPlanModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  topic: string;
  level: string;
  title: string;
  description: string;
  learningObjective: string;
  gains: string[];
  dailyAvailableMinutes: number;
  status: string; // "active" | "archived"
  milestones: PlanMilestoneModel[];
  createdAt: string;
  updatedAt: string;
}

export interface FeedbackModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  actorId: string;
  subjectType: string;
  subjectId: string;
  type: string;
  note?: string | null;
  createdAt: string;
}
