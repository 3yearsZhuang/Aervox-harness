/**
 * Aervox｜思隅 @aervox/worker — 复习到期提醒扫描
 *
 * 规则依据：PRD §8（ReviewItem / Notification）。
 *
 * 注意：扫描是系统级调度，仅读取本地 SQLite 中的调度字段；
 * 随后通过受控仓储创建通知与审计，不读取知识正文。
 */
import { createHash } from "node:crypto";
import { and, asc, eq, lte } from "drizzle-orm";
import {
  reviewItems,
} from "@aervox/schema";
import type {
  AervoxDatabase,
  KnowledgeRelationModel,
  SqlitePlatformRepository,
  SqliteLearningRepository,
} from "@aervox/repositories";

export interface ReviewNotifierContext {
  db: AervoxDatabase;
  platformRepo: SqlitePlatformRepository;
  learningRepo: SqliteLearningRepository;
  workerId: string;
}

/** Stable identity for one review-item occurrence; retries must not create a second notification. */
const occurrenceId = (prefix: string, item: { id: string; dueAt: string }): string => {
  const digest = createHash("sha256")
    .update(`${item.id}\u0000${item.dueAt}`)
    .digest("hex")
    .slice(0, 32);
  return `${prefix}_review_${digest}`;
};

/** 单次复习到期提醒扫描 */
export async function runReviewNotificationCycle(ctx: ReviewNotifierContext): Promise<number> {
  const now = new Date().toISOString();

  // 跨租户只读：查询到期且未处理的复习项（仅调度字段）
  const dueItems = await ctx.db
    .select({
      id: reviewItems.id,
      knowledgeId: reviewItems.knowledgeId,
      dueAt: reviewItems.dueAt,
    })
    .from(reviewItems)
    .where(and(eq(reviewItems.status, "active"), lte(reviewItems.dueAt, now)))
    .orderBy(asc(reviewItems.dueAt))
    .limit(100);

  const localContext = { workspaceId: "local", subjectUserId: "local" };
  const relationsByKnowledgeId: Map<string, KnowledgeRelationModel[]> = await ctx.learningRepo
    .listKnowledgeRelationsForKnowledgeIds(localContext, dueItems.map((item) => item.knowledgeId))
    .catch(() => new Map<string, KnowledgeRelationModel[]>());

  for (const item of dueItems) {
    await ctx.platformRepo.createNotificationIdempotent(localContext, {
      id: occurrenceId("ntf", item),
      type: "review",
      scheduledAt: now,
      channel: "in_app",
    });
    // P1 增强（CAP-015）：附带知识关系中的关联知识点，供关联复习/提醒策略使用
    const relations = relationsByKnowledgeId.get(item.knowledgeId) ?? [];
    await ctx.platformRepo.createAuditRecordIdempotent(localContext, {
      id: occurrenceId("aud", item),
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
