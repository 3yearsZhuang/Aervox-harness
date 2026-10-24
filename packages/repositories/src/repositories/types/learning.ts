/**
 * Aervox｜思隅 @aervox/repositories — learning 仓储类型（自 types.ts 机械拆分）
 */
import type { KnowledgeItemModel, LearningGoalModel, MistakeItemModel, PracticeSessionModel, QuestionAttemptModel, QuestionModel, ReviewItemModel } from "./user-question.js";
import type { PluginGenerationIdentity } from "../../plugin-generation-guard.js";
import type { LocalContext } from "../../local-context.js";

export interface LearningGoalPort {
  createLearningGoal(
    ctx: LocalContext,
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
    ctx: LocalContext,
    goal: {
      id: string;
      topic: string;
      level?: string;
      availableMinutes?: number;
      idempotencyKey: string;
    },
  ): Promise<{ goal: LearningGoalModel; created: boolean }>;
  getLearningGoal(ctx: LocalContext, id: string): Promise<LearningGoalModel | null>;
  listLearningGoals(ctx: LocalContext, includeArchived?: boolean): Promise<LearningGoalModel[]>;
  updateLearningGoal(
    ctx: LocalContext,
    id: string,
    goal: { topic?: string; level?: string; availableMinutes?: number; status?: string },
  ): Promise<LearningGoalModel | null>;
}

export interface QuestionPracticePort {
  createQuestion(
    ctx: LocalContext,
    question: {
      id: string;
      prompt: string;
      answerSpec: unknown;
      sourceArtifactId?: string | null;
      knowledgeId?: string | null;
    },
  ): Promise<QuestionModel>;
  getQuestion(ctx: LocalContext, id: string): Promise<QuestionModel | null>;
  listActiveQuestions(ctx: LocalContext, limit: number): Promise<QuestionModel[]>;
  createPracticeSession(
    ctx: LocalContext,
    session: { id: string; questionCount: number; questionIds: string[] },
  ): Promise<PracticeSessionModel>;
  getPracticeSession(ctx: LocalContext, sessionId: string): Promise<PracticeSessionModel | null>;
  getLatestActivePracticeSession(ctx: LocalContext): Promise<PracticeSessionModel | null>;
  completePracticeSession(ctx: LocalContext, sessionId: string): Promise<PracticeSessionModel | null>;
  listAttemptsByQuestion(ctx: LocalContext, questionId: string): Promise<QuestionAttemptModel[]>;
  listAttemptsBySession(ctx: LocalContext, sessionId: string): Promise<QuestionAttemptModel[]>;
  listPracticeAnswerOutcomes(ctx: LocalContext, sessionId: string): Promise<Array<QuestionAttemptModel & { nextStep: AnswerNextStep }>>;
  listMistakes(
    ctx: LocalContext,
    status?: "active" | "mastered" | "dismissed" | "all",
  ): Promise<MistakeItemModel[]>;
  setMistakeDisposition(ctx: LocalContext, item: { id: string; questionId: string; status: "active" | "dismissed" }): Promise<void>;
  setMistakeInsight(
    ctx: LocalContext,
    item: { id: string; questionId: string; reasonCode: "concept_gap" | "calculation" | "careless" | "misread" | "other"; note?: string | null },
  ): Promise<void>;
  clearMistakeInsight(ctx: LocalContext, questionId: string): Promise<void>;
}

export interface KnowledgeStatePort {
  createKnowledgeItem(
    ctx: LocalContext,
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
  getKnowledgeItem(ctx: LocalContext, id: string): Promise<KnowledgeItemModel | null>;
  updateMastery(ctx: LocalContext, id: string, masteryState: string, basis?: unknown): Promise<KnowledgeItemModel | null>;

}

export interface ReviewSchedulePort {
  listDueReviewSchedule(before: string, limit?: number): Promise<Array<{ id: string; knowledgeId: string; dueAt: string }>>;
  scheduleReviewItem(
    ctx: LocalContext,
    item: { id: string; knowledgeId: string; dueAt: string; intervalDays: number; schedulerVersion?: number; timezoneSnapshot?: string },
  ): Promise<ReviewItemModel>;
  createReviewItem(
    ctx: LocalContext,
    item: { id: string; knowledgeId: string; dueAt: string; intervalDays?: number; schedulerVersion?: number; timezoneSnapshot?: string },
  ): Promise<ReviewItemModel>;
  getReviewItem(ctx: LocalContext, id: string): Promise<ReviewItemModel | null>;
  listCompletedReviewItems(ctx: LocalContext, limit?: number): Promise<ReviewItemModel[]>;
  completeReviewAndSchedule(
    ctx: LocalContext,
    input: { reviewId: string; isCorrect: boolean; timeZone?: string },
    derive: LearningAnswerPolicy["derive"],
  ): Promise<{ completed: ReviewItemModel; nextReview: ReviewItemModel; knowledge: KnowledgeItemModel } | null>;
  listDueReviewItems(ctx: LocalContext, before: string): Promise<ReviewItemModel[]>;
  completeReviewItem(ctx: LocalContext, id: string): Promise<ReviewItemModel | null>;
}

export interface KnowledgeRelationPort {
  listKnowledgeRelationsForKnowledgeIds(ctx: LocalContext, knowledgeIds: string[]): Promise<Map<string, KnowledgeRelationModel[]>>;
  // P1（R2 · CAP-015）：思维宇宙知识关系
  createKnowledgeRelation(
    ctx: LocalContext,
    relation: {
      id: string;
      fromKnowledgeId: string;
      toKnowledgeId: string;
      relationType: string;
      source?: string;
      confidence?: number;
    },
  ): Promise<KnowledgeRelationModel>;
  listKnowledgeRelations(ctx: LocalContext, knowledgeId: string): Promise<KnowledgeRelationModel[]>;
  /** CAP-015：获取关系详情 */
  getKnowledgeRelation(ctx: LocalContext, relationId: string): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：纠正关系 — corrected 状态停止用于讲解和推荐 */
  correctKnowledgeRelation(
    ctx: LocalContext,
    relationId: string,
    reason: string,
  ): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：合并两条关系 */
  mergeKnowledgeRelations(
    ctx: LocalContext,
    sourceRelationId: string,
    targetRelationId: string,
  ): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：拆分关系（标记为 split，可选创建新关系） */
  splitKnowledgeRelation(
    ctx: LocalContext,
    relationId: string,
    reason: string,
  ): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：软删除关系 */
  deleteKnowledgeRelation(ctx: LocalContext, relationId: string): Promise<KnowledgeRelationModel | null>;
  /** CAP-015：获取知识图谱（仅 active 关系，用于讲解和推荐） */
  getActiveKnowledgeGraph(
    ctx: LocalContext,
    knowledgeId: string,
  ): Promise<KnowledgeRelationModel[]>;

}

export interface PracticeReportPort {
  // ============ CAP-016 练习报告 ============

  /** CAP-016：创建练习报告 */
  createPracticeReport(
    ctx: LocalContext,
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
      pluginGeneration?: PluginGenerationIdentity;
    },
  ): Promise<PracticeReportModel>;
  /** CAP-016：获取练习报告 */
  getPracticeReport(ctx: LocalContext, reportId: string): Promise<PracticeReportModel | null>;
  /** CAP-016：按会话查询报告 */
  listPracticeReports(ctx: LocalContext, sessionId: string): Promise<PracticeReportModel[]>;
  /** CAP-016：重置推断（保留原始作答） */
  resetMasteryInference(
    ctx: LocalContext,
    sessionId: string,
    pluginGeneration?: PluginGenerationIdentity,
  ): Promise<PracticeReportModel>;

}

export interface LearningPlanPort {
  // ============ CAP-017 学习规划（里程碑 + 任务路线图） ============

  /** 创建学习规划（事务写入规划 + 里程碑 + 任务） */
  createLearningPlan(
    ctx: LocalContext,
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
  getLearningPlan(ctx: LocalContext, planId: string): Promise<LearningPlanModel | null>;
  /** 列出规划 */
  listLearningPlans(ctx: LocalContext, includeArchived?: boolean): Promise<LearningPlanModel[]>;
  /** 更新任务状态并推进里程碑（任务全 done → 里程碑 completed + 下一里程碑 active） */
  transitionPlanTask(
    ctx: LocalContext,
    taskId: string,
    status: "todo" | "done",
    deriveMilestones: MilestoneTransitionPolicy,
  ): Promise<LearningPlanModel | null>;
  /** 归档规划 */
  archiveLearningPlan(ctx: LocalContext, planId: string): Promise<LearningPlanModel | null>;
}

export type MilestoneTransitionPolicy = (
  milestones: readonly { id: string; order: number; status: string }[],
  tasks: readonly { milestoneId: string; status: string }[],
) => Array<{ id: string; status: "completed" | "active" | "locked" }>;

/** Composition-only facade. Consumers depend on the specific use-case port above. */
export interface ILearningRepository extends LearningGoalPort, QuestionPracticePort, KnowledgeStatePort, ReviewSchedulePort, KnowledgeRelationPort, PracticeReportPort, LearningPlanPort, LearningAnswerCommandPort {}

export type AnswerJudgement = "correct" | "incorrect" | "partial" | "unverifiable";
export type AnswerNextStep = "continue" | "review_scheduled" | "await_review";
interface LearningAnswerBase {
  idempotencyKey?: string;
  timeZone?: string;
  hintCount?: number;
  timeSpentSec?: number;
  pluginGeneration?: PluginGenerationIdentity;
}
/** Both transports submit intent; source resolution and every write share one transaction. */
export type LearningAnswerCommand = LearningAnswerBase & ({
  kind: "existing-question";
  questionId: string;
  sessionId?: string;
  answer: string;
  evidence?: unknown;
} | {
  kind: "judged-question";
  idempotencyKey: string;
  /** Compatibility lookup only; old source-scoped host facts cannot be silently recreated. */
  legacyIdempotencyKey?: string;
  turnId: string;
  prompt: string;
  questionType?: string;
  userAnswer: string;
  correctAnswer: string;
  judgement: "correct" | "incorrect" | "partial";
  explanation?: string;
  knowledgeConcept?: string;
  source?: string;
});
/** Pure application policy, evaluated against the transaction's current state. */
export interface LearningAnswerPolicy {
  judge(answerSpec: unknown, answer: string): AnswerJudgement;
  derive(item: KnowledgeItemModel, isCorrect: boolean, now: Date, timeZone: string): {
    state: Pick<KnowledgeItemModel, "correctCount" | "wrongCount" | "correctStreak" | "mastery" | "masteryState" | "masteryBasis">;
    review: { dueAt: string; intervalDays: number; schedulerVersion: number; timezoneSnapshot: string };
  };
}
export interface LearningAnswerResult {
  attempt: QuestionAttemptModel;
  nextStep: AnswerNextStep;
  created: boolean;
}
export interface LearningAnswerCommandPort {
  recordAnswer(ctx: LocalContext, input: LearningAnswerCommand & { requestDigest: string }, policy: LearningAnswerPolicy): Promise<LearningAnswerResult>;
}

export interface KnowledgeRelationModel {
  id: string;
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
  actorId: string;
  subjectType: string;
  subjectId: string;
  type: string;
  note?: string | null;
  createdAt: string;
}
