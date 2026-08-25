/**
 * Aervox｜思隅 @aervox/worker — 复习到期提醒扫描
 *
 * 规则依据：PRD §8（ReviewItem / Notification）。
 *
 * 注意：扫描是系统级调度，需跨租户只读查询 due review items；
 * 仅读取租户列与调度字段，随后按租户调用受控仓储创建通知与审计，不读取正文。
 */
import { and, eq, lte } from "drizzle-orm";
import {
  reviewItems,
  type AervoxDatabase,
  type SqlitePlatformRepository,
  type SqliteLearningRepository,
} from "@aervox/database";

export interface ReviewNotifierContext {
  db: AervoxDatabase;
  platformRepo: SqlitePlatformRepository;
  learningRepo: SqliteLearningRepository;
  workerId: string;
}

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/** 单次复习到期提醒扫描 */
export async function runReviewNotificationCycle(ctx: ReviewNotifierContext): Promise<number> {
  const now = new Date().toISOString();

  // 跨租户只读：查询到期且未处理的复习项（仅调度字段）
  const dueItems = await ctx.db
    .select({
      workspaceId: reviewItems.workspaceId,
      subjectUserId: reviewItems.subjectUserId,
      id: reviewItems.id,
      knowledgeId: reviewItems.knowledgeId,
      dueAt: reviewItems.dueAt,
    })
    .from(reviewItems)
    .where(and(eq(reviewItems.status, "active"), lte(reviewItems.dueAt, now)))
    .limit(100);

  for (const item of dueItems) {
    const tenant = { workspaceId: item.workspaceId, subjectUserId: item.subjectUserId };
    await ctx.platformRepo.createNotification(tenant, {
      id: id("ntf"),
      type: "review",
      scheduledAt: now,
      channel: "in_app",
    });
    // P1 增强（CAP-015）：附带知识关系中的关联知识点，供关联复习/提醒策略使用
    const relations = await ctx.learningRepo
      .listKnowledgeRelations(tenant, item.knowledgeId)
      .catch(() => []);
    await ctx.platformRepo.createAuditRecord(tenant, {
      id: id("aud"),
      actorType: "system",
      actorId: `review:${ctx.workerId}`,
      action: "review.due.notified",
      subjectType: "review_item",
      subjectId: item.id,
      metadata: {
        knowledgeId: item.knowledgeId,
        dueAt: item.dueAt,
        relatedKnowledgeIds: relations.map((r) => r.toKnowledgeId),
      },
    });
  }
  return dueItems.length;
}
