/**
 * Aervox｜思隅 @aervox/database — 学习/练习/复习域 SQLite 仓储实现
 *
 * 规则依据：docs/PRD.md §8 + docs/contracts/DATABASE.md §14.3
 */
import { eq, and, lte, desc } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  learningGoals,
  questions,
  questionAttempts,
  knowledgeItems,
  reviewItems,
} from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  ILearningRepository,
  LearningGoalModel,
  QuestionModel,
  QuestionAttemptModel,
  KnowledgeItemModel,
  ReviewItemModel,
} from "../types.js";

export class SqliteLearningRepository implements ILearningRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async createLearningGoal(
    tenant: TenantContext,
    goalData: { id: string; topic: string; level?: string; availableMinutes?: number; status?: string },
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
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as LearningGoalModel;
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

  async listLearningGoals(tenant: TenantContext): Promise<LearningGoalModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(learningGoals)
      .where(
        and(
          eq(learningGoals.workspaceId, tenant.workspaceId),
          eq(learningGoals.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(learningGoals.updatedAt));
    return rows as LearningGoalModel[];
  }

  async createQuestion(
    tenant: TenantContext,
    questionData: { id: string; prompt: string; answerSpec: unknown; sourceArtifactId?: string | null },
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

  async createKnowledgeItem(
    tenant: TenantContext,
    itemData: { id: string; concept: string; sourceStatus?: string; masteryState?: string },
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
}
