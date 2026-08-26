/**
 * Aervox｜思隅 @aervox/database — 学习/练习/复习域 SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8 + docs/reference/DATABASE.md §14.3
 */
import { eq, and, lte, desc, ne } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  learningGoals,
  questions,
  questionAttempts,
  practiceSessions,
  knowledgeItems,
  reviewItems,
  knowledgeRelations,
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
    status: "active" | "mastered" | "all" = "active",
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
      })
      .from(questionAttempts)
      .innerJoin(questions, eq(questionAttempts.questionId, questions.id))
      .leftJoin(knowledgeItems, eq(questions.knowledgeId, knowledgeItems.id))
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
      grouped.set(row.questionId, {
        questionId: row.questionId,
        knowledgeId: row.knowledgeId,
        prompt: row.prompt,
        latestAnswer: row.latestAnswer,
        latestAttemptAt: row.latestAttemptAt,
        wrongCount: 1,
        masteryState,
        status: masteryState === "mastered" ? "mastered" : "active",
      });
    }
    return [...grouped.values()].filter((item) => status === "all" || item.status === status);
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
    itemData: { id: string; knowledgeId: string; dueAt: string; intervalDays?: number; schedulerVersion?: number },
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
        status: "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as ReviewItemModel;
  }

  async scheduleReviewItem(
    tenant: TenantContext,
    itemData: { id: string; knowledgeId: string; dueAt: string; intervalDays: number; schedulerVersion?: number },
  ): Promise<ReviewItemModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(reviewItems)
      .set({
        dueAt: itemData.dueAt,
        intervalDays: itemData.intervalDays,
        schedulerVersion: itemData.schedulerVersion ?? 1,
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

  async completeReviewAndSchedule(
    tenant: TenantContext,
    data: {
      reviewId: string;
      knowledgeId: string;
      practiceState: {
        correctCount: number;
        wrongCount: number;
        correctStreak: number;
        mastery: number;
        masteryState: string;
        masteryBasis: unknown;
      };
      nextReview: { id: string; dueAt: string; intervalDays: number; schedulerVersion: number };
    },
  ): Promise<{ completed: ReviewItemModel; nextReview: ReviewItemModel; knowledge: KnowledgeItemModel } | null> {
    assertTenantContext(tenant);
    return this.db.transaction(async (tx) => {
      const now = new Date().toISOString();
      const [completed] = await tx
        .update(reviewItems)
        .set({ status: "completed", updatedAt: now })
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
          // 出边或入边都算关联
          eq(knowledgeRelations.fromKnowledgeId, knowledgeId),
        ),
      )
      .orderBy(desc(knowledgeRelations.updatedAt));
    return rows as KnowledgeRelationModel[];
  }
}
