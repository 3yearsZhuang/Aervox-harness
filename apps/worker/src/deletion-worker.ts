/**
 * Aervox｜思隅 @aervox/worker — 删除传播 Worker
 *
 * 规则依据：PRD §8 数据规则（DeletionRequest/DeletionTarget）+ docs/reference/DATABASE.md §14.7。
 *
 * 消费未完成删除请求，逐 target 执行清除并标记 verifiedAt；全部完成后请求置 completed。
 * 骨架：清除动作以证据引用占位（真实存储/索引清理按 ownerModule 分发后续接入）。
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  deletionRequests,
  deletionTargets,
  type AervoxDatabase,
  type SqlitePrivacyRepository,
  type SqlitePlatformRepository,
  type TenantContext,
} from "@aervox/database";

export interface DeletionWorkerContext {
  db: AervoxDatabase;
  privacyRepo: SqlitePrivacyRepository;
  platformRepo: SqlitePlatformRepository;
  workerId: string;
}

const ACTIVE = ["pending", "in_progress"] as const;

/** 单次删除传播轮询；返回已完成的删除请求数 */
export async function runDeletionCycle(ctx: DeletionWorkerContext): Promise<number> {
  const requests = await ctx.db
    .select()
    .from(deletionRequests)
    .where(inArray(deletionRequests.status, [...ACTIVE]))
    .limit(20);

  let completed = 0;
  for (const request of requests) {
    const tenant: TenantContext = {
      workspaceId: request.workspaceId,
      subjectUserId: request.subjectUserId,
    };
    try {
      // 标记请求为处理中（幂等）
      await ctx.privacyRepo.updateDeletionRequestStatus(tenant, request.id, "in_progress");

      const targets = await ctx.db
        .select()
        .from(deletionTargets)
        .where(eq(deletionTargets.requestId, request.id));

      let allDone = true;
      let failures = 0;
      for (const target of targets) {
        if (target.status === "completed") continue;
        if (target.status === "failed") {
          failures += 1;
          continue;
        }
        // 骨架清除：按 ownerModule 分发后续（FTS/向量/对象存储/业务行），此处标记完成 + 证据引用
        await ctx.privacyRepo.updateDeletionTargetStatus(
          { requestId: request.id, targetType: target.targetType, targetId: target.targetId },
          "completed",
          `ev:${ctx.workerId}:${Date.now().toString(36)}`,
        );
      }
      const freshTargets = await ctx.db
        .select()
        .from(deletionTargets)
        .where(eq(deletionTargets.requestId, request.id));
      allDone = freshTargets.every((t) => t.status === "completed");
      failures = freshTargets.filter((t) => t.status === "failed").length;

      if (allDone) {
        await ctx.privacyRepo.updateDeletionRequestStatus(tenant, request.id, "completed", {
          lastVerifiedAt: new Date().toISOString(),
        });
        await ctx.platformRepo.createAuditRecord(tenant, {
          id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
          actorType: "system",
          actorId: `deletion:${ctx.workerId}`,
          action: "deletion.completed",
          subjectType: "deletion_request",
          subjectId: request.id,
          metadata: { scope: request.scope },
        });
        completed += 1;
      } else if (failures > 0) {
        await ctx.privacyRepo.updateDeletionRequestStatus(tenant, request.id, "failed", {
          lastError: `${failures} target(s) failed`,
          attemptCount: request.attemptCount + 1,
        });
      }
    } catch (err) {
      await ctx.privacyRepo.updateDeletionRequestStatus(tenant, request.id, "failed", {
        lastError: err instanceof Error ? err.message : String(err),
        attemptCount: request.attemptCount + 1,
      });
    }
  }
  return completed;
}
