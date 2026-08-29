/**
 * Aervox｜思隅 @aervox/database — 学习/练习/复习域 SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8 + docs/reference/DATABASE.md §14.3
 */
import { eq, and, lte, desc, ne, isNull, or, asc, inArray } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  learningGoals,
  questions,
  questionAttempts,
  practiceSessions,
  knowledgeItems,
  reviewItems,
  mistakeDispositions,
  mistakeInsights,
  knowledgeRelations,
  practiceReports,
  learningPlans,
  planMilestones,
  planTasks,
} from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  ILearningRepository,
  LearningGoalModel,
  QuestionModel,
  QuestionAttemptModel,
  MistakeItemModel,
  PracticeSessionModel,
  KnowledgeItemModel,
  ReviewItemModel,
  KnowledgeRelationModel,
  PracticeReportModel,
  LearningPlanModel,
  PlanMilestoneModel,
  PlanTaskModel,
} from "../types.js";

export class SqliteLearningRepository implements ILearningRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async createLearningGoal(
    tenant: TenantContext,
    goalData: {
      id: string;
      topic: string;
      level?: string;
      availableMinutes?: number;
      status?: string;
      idempotencyKey?: string | null;
    },
  ): Promise<LearningGoalModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(learningGoals)
      .values({
        id: goalData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        topic: goalData.topic,
        level: goalData.level ?? "beginner",
        availableMinutes: goalData.availableMinutes ?? 0,
        status: goalData.status ?? "active",
        idempotencyKey: goalData.idempotencyKey ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as LearningGoalModel;
  }

  async createLearningGoalIdempotent(
    tenant: TenantContext,
    goalData: {
      id: string;
      topic: string;
      level?: string;
      availableMinutes?: number;
      idempotencyKey: string;
    },
  ): Promise<{ goal: LearningGoalModel; created: boolean }> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const inserted = await this.db
      .insert(learningGoals)
      .values({
        id: goalData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        topic: goalData.topic,
        level: goalData.level ?? "beginner",
        availableMinutes: goalData.availableMinutes ?? 0,
        status: "active",
        idempotencyKey: goalData.idempotencyKey,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return { goal: inserted[0] as LearningGoalModel, created: true };

    const [existing] = await this.db
      .select()
      .from(learningGoals)
      .where(
        and(
          eq(learningGoals.workspaceId, tenant.workspaceId),
          eq(learningGoals.subjectUserId, tenant.subjectUserId),
          eq(learningGoals.idempotencyKey, goalData.idempotencyKey),
        ),
      );
    if (!existing) throw new Error("learning goal idempotency conflict without a stored goal");
    return { goal: existing as LearningGoalModel, created: false };
  }

  async getLearningGoal(tenant: TenantContext, id: string): Promise<LearningGoalModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(learningGoals)
      .where(
        and(
          eq(learningGoals.id, id),
          eq(learningGoals.workspaceId, tenant.workspaceId),
          eq(learningGoals.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found as LearningGoalModel) ?? null;
  }

  async listLearningGoals(tenant: TenantContext, includeArchived = false): Promise<LearningGoalModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(learningGoals)
      .where(
        includeArchived
          ? and(
              eq(learningGoals.workspaceId, tenant.workspaceId),
              eq(learningGoals.subjectUserId, tenant.subjectUserId),
            )
          : and(
              eq(learningGoals.workspaceId, tenant.workspaceId),
              eq(learningGoals.subjectUserId, tenant.subjectUserId),
              ne(learningGoals.status, "archived"),
            ),
      )
      .orderBy(desc(learningGoals.updatedAt));
    return rows as LearningGoalModel[];
  }

  async updateLearningGoal(
    tenant: TenantContext,
    id: string,
    goalData: { topic?: string; level?: string; availableMinutes?: number; status?: string },
  ): Promise<LearningGoalModel | null> {
    assertTenantContext(tenant);
    const [updated] = await this.db
      .update(learningGoals)
      .set({ ...goalData, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(learningGoals.id, id),
          eq(learningGoals.workspaceId, tenant.workspaceId),
          eq(learningGoals.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return (updated as LearningGoalModel) ?? null;
  }

  async createQuestion(
    tenant: TenantContext,
    questionData: {
      id: string;
      prompt: string;
      answerSpec: unknown;
      sourceArtifactId?: string | null;
      knowledgeId?: string | null;
    },
  ): Promise<QuestionModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(questions)
      .values({
        id: questionData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        sourceArtifactId: questionData.sourceArtifactId ?? null,
        knowledgeId: questionData.knowledgeId ?? null,
        prompt: questionData.prompt,
        answerSpec: questionData.answerSpec,
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as QuestionModel;
  }

  async getQuestion(tenant: TenantContext, id: string): Promise<QuestionModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(questions)
      .where(
        and(
          eq(questions.id, id),
          eq(questions.workspaceId, tenant.workspaceId),
          eq(questions.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found as QuestionModel) ?? null;
  }

  async listActiveQuestions(tenant: TenantContext, limit: number): Promise<QuestionModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(questions)
      .where(
        and(
          eq(questions.workspaceId, tenant.workspaceId),
          eq(questions.subjectUserId, tenant.subjectUserId),
          eq(questions.status, "active"),
        ),
      )
      .orderBy(questions.createdAt)
      .limit(limit);
    return rows as QuestionModel[];
  }

  async createPracticeSession(
    tenant: TenantContext,
    session: { id: string; questionCount: number; questionIds: string[] },
  ): Promise<PracticeSessionModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(practiceSessions)
      .values({
        id: session.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        questionCount: session.questionCount,
        questionIds: session.questionIds,
        status: "active",
        startedAt: now,
        endedAt: null,
      })
      .returning();
    return created as PracticeSessionModel;
  }

  async getPracticeSession(tenant: TenantContext, sessionId: string): Promise<PracticeSessionModel | null> {
    assertTenantContext(tenant);
    const [session] = await this.db
      .select()
      .from(practiceSessions)
      .where(
        and(
          eq(practiceSessions.id, sessionId),
          eq(practiceSessions.workspaceId, tenant.workspaceId),
          eq(practiceSessions.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (session as PracticeSessionModel) ?? null;
  }

  async getLatestActivePracticeSession(tenant: TenantContext): Promise<PracticeSessionModel | null> {
    assertTenantContext(tenant);
    const [session] = await this.db
      .select()
      .from(practiceSessions)
      .where(
        and(
          eq(practiceSessions.workspaceId, tenant.workspaceId),
          eq(practiceSessions.subjectUserId, tenant.subjectUserId),
          eq(practiceSessions.status, "active"),
        ),
      )
      .orderBy(desc(practiceSessions.startedAt))
      .limit(1);
    return (session as PracticeSessionModel) ?? null;
  }

  async completePracticeSession(tenant: TenantContext, sessionId: string): Promise<PracticeSessionModel | null> {
    assertTenantContext(tenant);
    const [updated] = await this.db
      .update(practiceSessions)
      .set({ status: "completed", endedAt: new Date().toISOString() })
      .where(
        and(
          eq(practiceSessions.id, sessionId),
          eq(practiceSessions.workspaceId, tenant.workspaceId),
          eq(practiceSessions.subjectUserId, tenant.subjectUserId),
          eq(practiceSessions.status, "active"),
        ),
      )
      .returning();
    if (updated) return updated as PracticeSessionModel;
    const existing = await this.getPracticeSession(tenant, sessionId);
    return existing?.status === "completed" ? existing : null;
  }

  /** 每次答题为不可变学习事实，仅追加不更新 */
  async recordAttempt(
    tenant: TenantContext,
    attemptData: {
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
  ): Promise<QuestionAttemptModel> {
    assertTenantContext(tenant);
    const [created] = await this.db
      .insert(questionAttempts)
      .values({
        id: attemptData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        sessionId: attemptData.sessionId,
        questionId: attemptData.questionId,
        answer: attemptData.answer,
        judgement: attemptData.judgement,
        evidence: attemptData.evidence ?? null,
        idempotencyKey: attemptData.idempotencyKey ?? null,
        hintCount: attemptData.hintCount ?? 0,
        timeSpentSec: attemptData.timeSpentSec ?? null,
        createdAt: new Date().toISOString(),
      })
      .returning();
    return created as QuestionAttemptModel;
  }

  async listAttemptsByQuestion(tenant: TenantContext, questionId: string): Promise<QuestionAttemptModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(questionAttempts)
      .where(
        and(
          eq(questionAttempts.questionId, questionId),
          eq(questionAttempts.workspaceId, tenant.workspaceId),
          eq(questionAttempts.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(questionAttempts.createdAt);
    return rows as QuestionAttemptModel[];
  }

  async listAttemptsBySession(tenant: TenantContext, sessionId: string): Promise<QuestionAttemptModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(questionAttempts)
      .where(
        and(
          eq(questionAttempts.sessionId, sessionId),
          eq(questionAttempts.workspaceId, tenant.workspaceId),
          eq(questionAttempts.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(questionAttempts.createdAt);
    return rows as QuestionAttemptModel[];
  }

  async listMistakes(
    tenant: TenantContext,
    status: "active" | "mastered" | "dismissed" | "all" = "active",
  ): Promise<MistakeItemModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select({
        questionId: questions.id,
        knowledgeId: questions.knowledgeId,
        prompt: questions.prompt,
        latestAnswer: questionAttempts.answer,
        latestAttemptAt: questionAttempts.createdAt,
        masteryState: knowledgeItems.masteryState,
        disposition: mistakeDispositions.status,
        reasonCode: mistakeInsights.reasonCode,
        note: mistakeInsights.note,
      })
      .from(questionAttempts)
      .innerJoin(questions, eq(questionAttempts.questionId, questions.id))
      .leftJoin(knowledgeItems, eq(questions.knowledgeId, knowledgeItems.id))
      .leftJoin(mistakeDispositions, and(eq(mistakeDispositions.questionId, questions.id), eq(mistakeDispositions.workspaceId, tenant.workspaceId), eq(mistakeDispositions.subjectUserId, tenant.subjectUserId)))
      .leftJoin(mistakeInsights, and(eq(mistakeInsights.questionId, questions.id), eq(mistakeInsights.workspaceId, tenant.workspaceId), eq(mistakeInsights.subjectUserId, tenant.subjectUserId)))
      .where(
        and(
          eq(questionAttempts.workspaceId, tenant.workspaceId),
          eq(questionAttempts.subjectUserId, tenant.subjectUserId),
          eq(questionAttempts.judgement, "incorrect"),
        ),
      )
      .orderBy(desc(questionAttempts.createdAt));

    const grouped = new Map<string, MistakeItemModel>();
    for (const row of rows) {
      const existing = grouped.get(row.questionId);
      if (existing) {
        existing.wrongCount += 1;
        continue;
      }
      const masteryState = row.masteryState ?? "unknown";
      const status = row.disposition === "dismissed" ? "dismissed" : masteryState === "mastered" ? "mastered" : "active";
      grouped.set(row.questionId, {
        questionId: row.questionId,
        knowledgeId: row.knowledgeId,
        prompt: row.prompt,
        latestAnswer: row.latestAnswer,
        latestAttemptAt: row.latestAttemptAt,
        wrongCount: 1,
        masteryState,
        status,
        reasonCode: row.reasonCode as MistakeItemModel["reasonCode"],
        note: row.note,
      });
    }
    return [...grouped.values()].filter((item) => status === "all" || item.status === status);
  }

  async setMistakeDisposition(tenant: TenantContext, item: { id: string; questionId: string; status: "active" | "dismissed" }): Promise<void> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    await this.db.insert(mistakeDispositions).values({ ...item, ...tenant, createdAt: now, updatedAt: now }).onConflictDoUpdate({
      target: [mistakeDispositions.workspaceId, mistakeDispositions.subjectUserId, mistakeDispositions.questionId],
      set: {
        status: item.status,
        // reason/note 已废弃（CR-018 统一至 mistake_insights 标准枚举，见 §4.2），不再写入
        updatedAt: now,
      },
    });
  }

  async setMistakeInsight(
    tenant: TenantContext,
    item: { id: string; questionId: string; reasonCode: "concept_gap" | "calculation" | "careless" | "misread" | "other"; note?: string | null },
  ): Promise<void> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    await this.db.insert(mistakeInsights).values({ ...item, ...tenant, createdAt: now, updatedAt: now }).onConflictDoUpdate({
      target: [mistakeInsights.workspaceId, mistakeInsights.subjectUserId, mistakeInsights.questionId],
      set: { reasonCode: item.reasonCode, note: item.note ?? null, updatedAt: now },
    });
  }

  async clearMistakeInsight(tenant: TenantContext, questionId: string): Promise<void> {
    assertTenantContext(tenant);
    await this.db.delete(mistakeInsights).where(and(
      eq(mistakeInsights.workspaceId, tenant.workspaceId),
      eq(mistakeInsights.subjectUserId, tenant.subjectUserId),
      eq(mistakeInsights.questionId, questionId),
    ));
  }

  async getAttemptByIdempotencyKey(
    tenant: TenantContext,
    questionId: string,
    idempotencyKey: string,
  ): Promise<QuestionAttemptModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(questionAttempts)
      .where(
        and(
          eq(questionAttempts.workspaceId, tenant.workspaceId),
          eq(questionAttempts.subjectUserId, tenant.subjectUserId),
          eq(questionAttempts.questionId, questionId),
          eq(questionAttempts.idempotencyKey, idempotencyKey),
        ),
      );
    return (found as QuestionAttemptModel) ?? null;
  }

  /** 幂等作答：先查后插，依赖 (tenant, question, idempotency_key) 唯一索引并发兜底；重复返回已有记录与 created=false */
  async recordAttemptIdempotent(
    tenant: TenantContext,
    attemptData: {
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
  ): Promise<{ attempt: QuestionAttemptModel; created: boolean }> {
    assertTenantContext(tenant);
    const findExisting = async (): Promise<QuestionAttemptModel | null> => {
      const [found] = await this.db
        .select()
        .from(questionAttempts)
        .where(
          and(
            eq(questionAttempts.workspaceId, tenant.workspaceId),
            eq(questionAttempts.subjectUserId, tenant.subjectUserId),
            eq(questionAttempts.questionId, attemptData.questionId),
            eq(questionAttempts.idempotencyKey, attemptData.idempotencyKey),
          ),
        );
      return (found as QuestionAttemptModel) ?? null;
    };

    const existing = await findExisting();
    if (existing) return { attempt: existing, created: false };

    try {
      const [inserted] = await this.db
        .insert(questionAttempts)
        .values({
          id: attemptData.id,
          workspaceId: tenant.workspaceId,
          subjectUserId: tenant.subjectUserId,
          sessionId: attemptData.sessionId,
          questionId: attemptData.questionId,
          answer: attemptData.answer,
          judgement: attemptData.judgement,
          evidence: attemptData.evidence ?? null,
          idempotencyKey: attemptData.idempotencyKey,
          hintCount: attemptData.hintCount ?? 0,
          timeSpentSec: attemptData.timeSpentSec ?? null,
          createdAt: new Date().toISOString(),
        })
        .returning();
      return { attempt: inserted as QuestionAttemptModel, created: true };
    } catch {
      // 并发竞态：唯一索引兜底后重查，命中即视为已存在
      const raced = await findExisting();
      if (raced) return { attempt: raced, created: false };
      throw new Error("recordAttemptIdempotent: 唯一索引约束与查询结果不一致");
    }
  }

  async createKnowledgeItem(
    tenant: TenantContext,
    itemData: {
      id: string;
      concept: string;
      sourceStatus?: string;
      masteryState?: string;
      correctCount?: number;
      wrongCount?: number;
      correctStreak?: number;
      mastery?: number;
    },
  ): Promise<KnowledgeItemModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(knowledgeItems)
      .values({
        id: itemData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        concept: itemData.concept,
        sourceStatus: itemData.sourceStatus ?? "inferred",
        masteryState: itemData.masteryState ?? "unknown",
        correctCount: itemData.correctCount ?? 0,
        wrongCount: itemData.wrongCount ?? 0,
        correctStreak: itemData.correctStreak ?? 0,
        mastery: itemData.mastery ?? 0,
        masteryBasis: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as KnowledgeItemModel;
  }

  async getKnowledgeItem(tenant: TenantContext, id: string): Promise<KnowledgeItemModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(knowledgeItems)
      .where(
        and(
          eq(knowledgeItems.id, id),
          eq(knowledgeItems.workspaceId, tenant.workspaceId),
          eq(knowledgeItems.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found as KnowledgeItemModel) ?? null;
  }

  async updateMastery(
    tenant: TenantContext,
    id: string,
    masteryState: string,
    basis?: unknown,
  ): Promise<KnowledgeItemModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = { masteryState, updatedAt: now };
    if (basis !== undefined) updateData.masteryBasis = basis;
    const [updated] = await this.db
      .update(knowledgeItems)
      .set(updateData)
      .where(
        and(
          eq(knowledgeItems.id, id),
          eq(knowledgeItems.workspaceId, tenant.workspaceId),
          eq(knowledgeItems.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return (updated as KnowledgeItemModel) ?? null;
  }

  async updatePracticeState(
    tenant: TenantContext,
    id: string,
    state: {
      correctCount: number;
      wrongCount: number;
      correctStreak: number;
      mastery: number;
      masteryState: string;
      masteryBasis: unknown;
    },
  ): Promise<KnowledgeItemModel | null> {
    assertTenantContext(tenant);
    const [updated] = await this.db
      .update(knowledgeItems)
      .set({ ...state, updatedAt: new Date().toISOString() })
      .where(
        and(
          eq(knowledgeItems.id, id),
          eq(knowledgeItems.workspaceId, tenant.workspaceId),
          eq(knowledgeItems.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return (updated as KnowledgeItemModel) ?? null;
  }

  async createReviewItem(
    tenant: TenantContext,
    itemData: { id: string; knowledgeId: string; dueAt: string; intervalDays?: number; schedulerVersion?: number; timezoneSnapshot?: string },
  ): Promise<ReviewItemModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(reviewItems)
      .values({
        id: itemData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        knowledgeId: itemData.knowledgeId,
        dueAt: itemData.dueAt,
        intervalDays: itemData.intervalDays ?? 1,
        schedulerVersion: itemData.schedulerVersion ?? 1,
        timezoneSnapshot: itemData.timezoneSnapshot ?? "UTC",
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as ReviewItemModel;
  }

  async scheduleReviewItem(
    tenant: TenantContext,
    itemData: { id: string; knowledgeId: string; dueAt: string; intervalDays: number; schedulerVersion?: number; timezoneSnapshot?: string },
  ): Promise<ReviewItemModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(reviewItems)
      .set({
        dueAt: itemData.dueAt,
        intervalDays: itemData.intervalDays,
        schedulerVersion: itemData.schedulerVersion ?? 1,
        timezoneSnapshot: itemData.timezoneSnapshot ?? "UTC",
        updatedAt: now,
      })
      .where(
        and(
          eq(reviewItems.workspaceId, tenant.workspaceId),
          eq(reviewItems.subjectUserId, tenant.subjectUserId),
          eq(reviewItems.knowledgeId, itemData.knowledgeId),
          eq(reviewItems.status, "active"),
        ),
      )
      .returning();
    if (updated) return updated as ReviewItemModel;
    return this.createReviewItem(tenant, itemData);
  }

  async getReviewItem(tenant: TenantContext, id: string): Promise<ReviewItemModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.id, id),
          eq(reviewItems.workspaceId, tenant.workspaceId),
          eq(reviewItems.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found as ReviewItemModel) ?? null;
  }

  async listCompletedReviewItems(tenant: TenantContext, limit = 10): Promise<ReviewItemModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.workspaceId, tenant.workspaceId),
          eq(reviewItems.subjectUserId, tenant.subjectUserId),
          eq(reviewItems.status, "completed"),
        ),
      )
      .orderBy(desc(reviewItems.updatedAt))
      .limit(limit);
    return rows as ReviewItemModel[];
  }

  async completeReviewAndSchedule(
    tenant: TenantContext,
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
  ): Promise<{ completed: ReviewItemModel; nextReview: ReviewItemModel; knowledge: KnowledgeItemModel } | null> {
    assertTenantContext(tenant);
    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const [completed] = await tx
        .update(reviewItems)
        .set({ status: "completed", completionIsCorrect: data.isCorrect, nextReviewId: data.nextReview.id, updatedAt: now })
        .where(
          and(
            eq(reviewItems.id, data.reviewId),
            eq(reviewItems.knowledgeId, data.knowledgeId),
            eq(reviewItems.workspaceId, tenant.workspaceId),
            eq(reviewItems.subjectUserId, tenant.subjectUserId),
            eq(reviewItems.status, "active"),
          ),
        )
        .returning();
      if (!completed) return null;

      const [knowledge] = await tx
        .update(knowledgeItems)
        .set({ ...data.practiceState, updatedAt: now })
        .where(
          and(
            eq(knowledgeItems.id, data.knowledgeId),
            eq(knowledgeItems.workspaceId, tenant.workspaceId),
            eq(knowledgeItems.subjectUserId, tenant.subjectUserId),
          ),
        )
        .returning();
      if (!knowledge) throw new Error("review completion references a missing knowledge item");

      const [nextReview] = await tx
        .insert(reviewItems)
        .values({
          id: data.nextReview.id,
          workspaceId: tenant.workspaceId,
          subjectUserId: tenant.subjectUserId,
          knowledgeId: data.knowledgeId,
          dueAt: data.nextReview.dueAt,
          intervalDays: data.nextReview.intervalDays,
          schedulerVersion: data.nextReview.schedulerVersion,
          timezoneSnapshot: data.nextReview.timezoneSnapshot,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return {
        completed: completed as ReviewItemModel,
        nextReview: nextReview as ReviewItemModel,
        knowledge: knowledge as KnowledgeItemModel,
      };
    });
  }

  async listDueReviewItems(tenant: TenantContext, before: string): Promise<ReviewItemModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.workspaceId, tenant.workspaceId),
          eq(reviewItems.subjectUserId, tenant.subjectUserId),
          eq(reviewItems.status, "active"),
          lte(reviewItems.dueAt, before),
        ),
      )
      .orderBy(reviewItems.dueAt);
    return rows as ReviewItemModel[];
  }

  async completeReviewItem(tenant: TenantContext, id: string): Promise<ReviewItemModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(reviewItems)
      .set({ status: "completed", updatedAt: now })
      .where(
        and(
          eq(reviewItems.id, id),
          eq(reviewItems.workspaceId, tenant.workspaceId),
          eq(reviewItems.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return (updated as ReviewItemModel) ?? null;
  }

  // ============ P1（R2 · CAP-015）：思维宇宙知识关系 ============

  async createKnowledgeRelation(
    tenant: TenantContext,
    relationData: {
      id: string;
      fromKnowledgeId: string;
      toKnowledgeId: string;
      relationType: string;
      source?: string;
      confidence?: number;
    },
  ): Promise<KnowledgeRelationModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(knowledgeRelations)
      .values({
        id: relationData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        fromKnowledgeId: relationData.fromKnowledgeId,
        toKnowledgeId: relationData.toKnowledgeId,
        relationType: relationData.relationType,
        source: relationData.source ?? "inference",
        confidence: relationData.confidence ?? 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as KnowledgeRelationModel;
  }

  async listKnowledgeRelations(tenant: TenantContext, knowledgeId: string): Promise<KnowledgeRelationModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(knowledgeRelations)
      .where(
        and(
          eq(knowledgeRelations.workspaceId, tenant.workspaceId),
          eq(knowledgeRelations.subjectUserId, tenant.subjectUserId),
          isNull(knowledgeRelations.deletedAt),
          // 出边或入边都算关联
          or(
            eq(knowledgeRelations.fromKnowledgeId, knowledgeId),
            eq(knowledgeRelations.toKnowledgeId, knowledgeId),
          ),
        ),
      )
      .orderBy(desc(knowledgeRelations.updatedAt));
    return rows as KnowledgeRelationModel[];
  }

  // ============ CAP-015 思维宇宙 ============

  async getKnowledgeRelation(
    tenant: TenantContext,
    relationId: string,
  ): Promise<KnowledgeRelationModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(knowledgeRelations)
      .where(
        and(
          eq(knowledgeRelations.id, relationId),
          eq(knowledgeRelations.workspaceId, tenant.workspaceId),
          eq(knowledgeRelations.subjectUserId, tenant.subjectUserId),
          isNull(knowledgeRelations.deletedAt),
        ),
      )
      .limit(1);
    return (found as KnowledgeRelationModel) ?? null;
  }

  async correctKnowledgeRelation(
    tenant: TenantContext,
    relationId: string,
    reason: string,
  ): Promise<KnowledgeRelationModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(knowledgeRelations)
      .set({ correctionStatus: "corrected", correctionReason: reason, updatedAt: now })
      .where(
        and(
          eq(knowledgeRelations.id, relationId),
          eq(knowledgeRelations.workspaceId, tenant.workspaceId),
          eq(knowledgeRelations.subjectUserId, tenant.subjectUserId),
          eq(knowledgeRelations.correctionStatus, "active"),
          isNull(knowledgeRelations.deletedAt),
        ),
      )
      .returning();
    return (updated as KnowledgeRelationModel) ?? null;
  }

  async mergeKnowledgeRelations(
    tenant: TenantContext,
    sourceRelationId: string,
    targetRelationId: string,
  ): Promise<KnowledgeRelationModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    // 标记源关系为 merged
    const [updated] = await this.db
      .update(knowledgeRelations)
      .set({ correctionStatus: "merged", mergedInto: targetRelationId, updatedAt: now })
      .where(
        and(
          eq(knowledgeRelations.id, sourceRelationId),
          eq(knowledgeRelations.workspaceId, tenant.workspaceId),
          eq(knowledgeRelations.subjectUserId, tenant.subjectUserId),
          eq(knowledgeRelations.correctionStatus, "active"),
          isNull(knowledgeRelations.deletedAt),
        ),
      )
      .returning();
    return (updated as KnowledgeRelationModel) ?? null;
  }

  async splitKnowledgeRelation(
    tenant: TenantContext,
    relationId: string,
    reason: string,
  ): Promise<KnowledgeRelationModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(knowledgeRelations)
      .set({ correctionStatus: "split", correctionReason: reason, updatedAt: now })
      .where(
        and(
          eq(knowledgeRelations.id, relationId),
          eq(knowledgeRelations.workspaceId, tenant.workspaceId),
          eq(knowledgeRelations.subjectUserId, tenant.subjectUserId),
          eq(knowledgeRelations.correctionStatus, "active"),
          isNull(knowledgeRelations.deletedAt),
        ),
      )
      .returning();
    return (updated as KnowledgeRelationModel) ?? null;
  }

  async deleteKnowledgeRelation(
    tenant: TenantContext,
    relationId: string,
  ): Promise<KnowledgeRelationModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(knowledgeRelations)
      .set({ correctionStatus: "deleted", deletedAt: now, updatedAt: now })
      .where(
        and(
          eq(knowledgeRelations.id, relationId),
          eq(knowledgeRelations.workspaceId, tenant.workspaceId),
          eq(knowledgeRelations.subjectUserId, tenant.subjectUserId),
          isNull(knowledgeRelations.deletedAt),
        ),
      )
      .returning();
    return (updated as KnowledgeRelationModel) ?? null;
  }

  async getActiveKnowledgeGraph(
    tenant: TenantContext,
    knowledgeId: string,
  ): Promise<KnowledgeRelationModel[]> {
    assertTenantContext(tenant);
    // 仅返回 active 关系（被纠正/合并/拆分/删除的不返回）
    const rows = await this.db
      .select()
      .from(knowledgeRelations)
      .where(
        and(
          eq(knowledgeRelations.workspaceId, tenant.workspaceId),
          eq(knowledgeRelations.subjectUserId, tenant.subjectUserId),
          eq(knowledgeRelations.correctionStatus, "active"),
          isNull(knowledgeRelations.deletedAt),
          or(
            eq(knowledgeRelations.fromKnowledgeId, knowledgeId),
            eq(knowledgeRelations.toKnowledgeId, knowledgeId),
          ),
        ),
      )
      .orderBy(desc(knowledgeRelations.confidence));
    return rows as KnowledgeRelationModel[];
  }

  // ============ CAP-016 练习报告 ============

  async createPracticeReport(
    tenant: TenantContext,
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
  ): Promise<PracticeReportModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(practiceReports)
      .values({
        id: input.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        sessionId: input.sessionId,
        totalQuestions: input.totalQuestions,
        correctCount: input.correctCount,
        incorrectCount: input.incorrectCount,
        avgTimeSpentSec: input.avgTimeSpentSec ?? null,
        totalHintsUsed: input.totalHintsUsed ?? 0,
        masteryPrediction: input.masteryPrediction ?? null,
        biasAssessment: input.biasAssessment ?? null,
        reportType: input.reportType ?? "summary",
        isReset: false,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as PracticeReportModel;
  }

  async getPracticeReport(tenant: TenantContext, reportId: string): Promise<PracticeReportModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(practiceReports)
      .where(
        and(
          eq(practiceReports.id, reportId),
          eq(practiceReports.workspaceId, tenant.workspaceId),
          eq(practiceReports.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    return (found as PracticeReportModel) ?? null;
  }

  async listPracticeReports(tenant: TenantContext, sessionId: string): Promise<PracticeReportModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(practiceReports)
      .where(
        and(
          eq(practiceReports.sessionId, sessionId),
          eq(practiceReports.workspaceId, tenant.workspaceId),
          eq(practiceReports.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(practiceReports.createdAt));
    return rows as PracticeReportModel[];
  }

  async resetMasteryInference(tenant: TenantContext, sessionId: string): Promise<PracticeReportModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    // 创建一个 reset 类型的报告（保留原始作答，仅重置推断）
    const [created] = await this.db
      .insert(practiceReports)
      .values({
        id: `rpt_reset_${Date.now().toString(36)}`,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        sessionId,
        totalQuestions: 0,
        correctCount: 0,
        incorrectCount: 0,
        totalHintsUsed: 0,
        reportType: "reset",
        isReset: true,
        masteryPrediction: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as PracticeReportModel;
  }

  // ============ CAP-017 学习规划（里程碑 + 任务路线图） ============

  async createLearningPlan(
    tenant: TenantContext,
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
  ): Promise<LearningPlanModel> {
    assertTenantContext(tenant);
    await this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      await tx.insert(learningPlans).values({
        id: input.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        topic: input.topic,
        level: input.level ?? "beginner",
        title: input.title,
        description: input.description,
        learningObjective: input.learningObjective,
        gains: input.gains ?? [],
        dailyAvailableMinutes: input.dailyAvailableMinutes ?? 25,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      for (const [index, milestone] of input.milestones.entries()) {
        await tx.insert(planMilestones).values({
          id: milestone.id,
          workspaceId: tenant.workspaceId,
          subjectUserId: tenant.subjectUserId,
          planId: input.id,
          order: index,
          title: milestone.title,
          description: milestone.description ?? null,
          briefing: milestone.briefing ?? null,
          completionCriteria: milestone.completionCriteria ?? null,
          debrief: milestone.debrief ?? null,
          // 首个里程碑 active，其余 locked（任务完成驱动推进）
          status: index === 0 ? "active" : "locked",
          createdAt: now,
          updatedAt: now,
        });
        for (const [taskIndex, task] of milestone.tasks.entries()) {
          await tx.insert(planTasks).values({
            id: task.id,
            workspaceId: tenant.workspaceId,
            subjectUserId: tenant.subjectUserId,
            milestoneId: milestone.id,
            order: taskIndex,
            title: task.title,
            description: task.description ?? null,
            hints: task.hints ?? [],
            status: "todo",
            createdAt: now,
            updatedAt: now,
          });
        }
      }
    });
    const created = await this.getLearningPlan(tenant, input.id);
    if (!created) throw new Error("learning plan creation failed to persist");
    return created;
  }

  async getLearningPlan(tenant: TenantContext, planId: string): Promise<LearningPlanModel | null> {
    assertTenantContext(tenant);
    const [plan] = await this.db
      .select()
      .from(learningPlans)
      .where(
        and(
          eq(learningPlans.id, planId),
          eq(learningPlans.workspaceId, tenant.workspaceId),
          eq(learningPlans.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    if (!plan) return null;
    const milestones = await this.listPlanMilestones(tenant, [plan.id]);
    return this.hydratePlan(plan, milestones);
  }

  async listLearningPlans(
    tenant: TenantContext,
    includeArchived = false,
  ): Promise<LearningPlanModel[]> {
    assertTenantContext(tenant);
    const planRows = await this.db
      .select()
      .from(learningPlans)
      .where(
        includeArchived
          ? and(eq(learningPlans.workspaceId, tenant.workspaceId), eq(learningPlans.subjectUserId, tenant.subjectUserId))
          : and(
              eq(learningPlans.workspaceId, tenant.workspaceId),
              eq(learningPlans.subjectUserId, tenant.subjectUserId),
              eq(learningPlans.status, "active"),
            ),
      )
      .orderBy(desc(learningPlans.updatedAt));
    if (planRows.length === 0) return [];
    const milestones = await this.listPlanMilestones(tenant, planRows.map((plan) => plan.id));
    return planRows.map((plan) =>
      this.hydratePlan(
        plan,
        milestones.filter((milestone) => milestone.planId === plan.id),
      ),
    );
  }

  async setPlanTaskStatus(
    tenant: TenantContext,
    taskId: string,
    status: "todo" | "done",
  ): Promise<LearningPlanModel | null> {
    assertTenantContext(tenant);
    const [task] = await this.db
      .select()
      .from(planTasks)
      .where(
        and(
          eq(planTasks.id, taskId),
          eq(planTasks.workspaceId, tenant.workspaceId),
          eq(planTasks.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    if (!task) return null;
    const [milestone] = await this.db
      .select()
      .from(planMilestones)
      .where(eq(planMilestones.id, task.milestoneId))
      .limit(1);
    if (!milestone) return null;

    const now = new Date().toISOString();
    await this.db.transaction(async (tx) => {
      await tx
        .update(planTasks)
        .set({ status, updatedAt: now })
        .where(eq(planTasks.id, taskId));
      // 里程碑链推进：前置里程碑全部完成 → completed；其后第一个未完成 → active；再后 → locked
      const chain = await tx
        .select()
        .from(planMilestones)
        .where(
          and(
            eq(planMilestones.planId, milestone.planId),
            eq(planMilestones.workspaceId, tenant.workspaceId),
            eq(planMilestones.subjectUserId, tenant.subjectUserId),
          ),
        )
        .orderBy(asc(planMilestones.order));
      const milestoneIds = chain.map((item) => item.id);
      const taskRows =
        milestoneIds.length > 0
          ? await tx.select().from(planTasks).where(inArray(planTasks.milestoneId, milestoneIds))
          : [];
      let chainComplete = true;
      for (const item of chain) {
        const itemTasks = taskRows.filter((row) => row.milestoneId === item.id);
        const allDone =
          itemTasks.length > 0 && itemTasks.every((row) => row.status === "done");
        const nextStatus = allDone && chainComplete ? "completed" : chainComplete ? "active" : "locked";
        if (!allDone) chainComplete = false;
        if (item.status !== nextStatus) {
          await tx
            .update(planMilestones)
            .set({ status: nextStatus, updatedAt: now })
            .where(eq(planMilestones.id, item.id));
        }
      }
    });
    return this.getLearningPlan(tenant, milestone.planId);
  }

  async archiveLearningPlan(tenant: TenantContext, planId: string): Promise<LearningPlanModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(learningPlans)
      .set({ status: "archived", updatedAt: now })
      .where(
        and(
          eq(learningPlans.id, planId),
          eq(learningPlans.workspaceId, tenant.workspaceId),
          eq(learningPlans.subjectUserId, tenant.subjectUserId),
          eq(learningPlans.status, "active"),
        ),
      )
      .returning();
    if (!updated) return null;
    return this.getLearningPlan(tenant, planId);
  }

  /** 把 plan 行 + 里程碑聚合为 LearningPlanModel */
  private hydratePlan(
    plan: typeof learningPlans.$inferSelect,
    milestones: PlanMilestoneModel[],
  ): LearningPlanModel {
    return {
      id: plan.id,
      workspaceId: plan.workspaceId,
      subjectUserId: plan.subjectUserId,
      topic: plan.topic,
      level: plan.level,
      title: plan.title,
      description: plan.description,
      learningObjective: plan.learningObjective,
      gains: (plan.gains as string[]) ?? [],
      dailyAvailableMinutes: plan.dailyAvailableMinutes,
      status: plan.status,
      milestones,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    };
  }

  /** 聚合指定规划的里程碑（含任务，按 sort_order 排序） */
  private async listPlanMilestones(tenant: TenantContext, planIds: string[]) {
    if (planIds.length === 0) return [];
    const milestoneRows = await this.db
      .select()
      .from(planMilestones)
      .where(
        and(
          inArray(planMilestones.planId, planIds),
          eq(planMilestones.workspaceId, tenant.workspaceId),
          eq(planMilestones.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(asc(planMilestones.order));
    const milestoneIds = milestoneRows.map((row) => row.id);
    const taskRows =
      milestoneIds.length > 0
        ? await this.db
            .select()
            .from(planTasks)
            .where(
              and(
                inArray(planTasks.milestoneId, milestoneIds),
                eq(planTasks.workspaceId, tenant.workspaceId),
                eq(planTasks.subjectUserId, tenant.subjectUserId),
              ),
            )
            .orderBy(asc(planTasks.order))
        : [];
    return milestoneRows.map(
      (milestone): PlanMilestoneModel => ({
        id: milestone.id,
        workspaceId: milestone.workspaceId,
        subjectUserId: milestone.subjectUserId,
        planId: milestone.planId,
        order: milestone.order,
        title: milestone.title,
        description: milestone.description,
        briefing: milestone.briefing,
        completionCriteria: milestone.completionCriteria,
        debrief: milestone.debrief,
        status: milestone.status,
        tasks: taskRows
          .filter((task) => task.milestoneId === milestone.id)
          .map(
            (task): PlanTaskModel => ({
              id: task.id,
              workspaceId: task.workspaceId,
              subjectUserId: task.subjectUserId,
              milestoneId: task.milestoneId,
              order: task.order,
              title: task.title,
              description: task.description,
              hints: (task.hints as string[]) ?? [],
              status: task.status,
              createdAt: task.createdAt,
              updatedAt: task.updatedAt,
            }),
          ),
        createdAt: milestone.createdAt,
        updatedAt: milestone.updatedAt,
      }),
    );
  }
}
