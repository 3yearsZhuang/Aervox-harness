/**
 * Aervox｜思隅 @aervox/database — 质量反馈 SQLite 仓储实现
 *
 * 规则依据：docs/PRD.md §8（Feedback）
 */
import { eq, and, desc } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { feedback } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type { IFeedbackRepository, FeedbackModel } from "../types.js";

export class SqliteFeedbackRepository implements IFeedbackRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async createFeedback(
    tenant: TenantContext,
    feedbackData: {
      id: string;
      actorId: string;
      subjectType: string;
      subjectId: string;
      type: string;
      note?: string | null;
    },
  ): Promise<FeedbackModel> {
    assertTenantContext(tenant);
    const [created] = await this.db
      .insert(feedback)
      .values({
        id: feedbackData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        actorId: feedbackData.actorId,
        subjectType: feedbackData.subjectType,
        subjectId: feedbackData.subjectId,
        type: feedbackData.type,
        note: feedbackData.note ?? null,
        createdAt: new Date().toISOString(),
      })
      .returning();
    return created as FeedbackModel;
  }

  async listFeedback(
    tenant: TenantContext,
    subjectType?: string,
    subjectId?: string,
  ): Promise<FeedbackModel[]> {
    assertTenantContext(tenant);
    const conditions = [
      eq(feedback.workspaceId, tenant.workspaceId),
      eq(feedback.subjectUserId, tenant.subjectUserId),
    ];
    if (subjectType && subjectId) {
      conditions.push(eq(feedback.subjectType, subjectType), eq(feedback.subjectId, subjectId));
    }
    const rows = await this.db
      .select()
      .from(feedback)
      .where(and(...conditions))
      .orderBy(desc(feedback.createdAt));
    return rows as FeedbackModel[];
  }
}
