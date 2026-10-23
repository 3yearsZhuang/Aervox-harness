/** Delete only explicitly supported targets; completion requires independent verification. */
import { MEMORY_DELETION_VERIFIER, type SqliteMemoryDeletionStore, type DeletionQueuePort, type SqlitePlatformRepository } from "@aervox/repositories";

export interface DeletionWorkerContext {
  memoryDeletion: Pick<SqliteMemoryDeletionStore, "clean" | "verify">;
  privacyRepo: DeletionQueuePort;
  platformRepo: Pick<SqlitePlatformRepository, "createAuditRecord">;
  workerId: string;
}
const local = { workspaceId: "local", subjectUserId: "local" };

/** 删除拒绝原因码（稳定字符串；失败保持解闸关闭，供用户可见与审计） */
export const DELETION_FAILURE_REASONS = {
  scopeUnsupported: "deletion_scope_unsupported",
  targetsEmpty: "deletion_targets_empty",
  targetUnsupported: "deletion_target_unsupported",
} as const;

/** Failed work is idempotently retried by later polling cycles and stays denied throughout. */
export async function runDeletionCycle(ctx: DeletionWorkerContext): Promise<number> {
  const requests = await ctx.privacyRepo.listUnverifiedDeletionRequests();
  const memory = ctx.memoryDeletion;
  let completed = 0;
  for (const request of requests) {
    try {
      const claimed = await ctx.privacyRepo.beginDeletionRequestAttempt(request.id);
      if (!claimed) continue;
      const targets = await ctx.privacyRepo.listDeletionTargets(request.id);
      if (request.scope !== "memory" || request.ownerModule !== "memory") throw new Error(DELETION_FAILURE_REASONS.scopeUnsupported);
      if (!targets.length) throw new Error(DELETION_FAILURE_REASONS.targetsEmpty);
      // Validate the whole dispatch set before mutating any target.
      if (targets.some((t) => t.ownerModule !== "memory" || t.targetType !== "memory" || !t.targetId)) {
        throw new Error(DELETION_FAILURE_REASONS.targetUnsupported);
      }
      for (const target of targets) {
        const key = { requestId: request.id, targetType: target.targetType, targetId: target.targetId };
        try {
          await ctx.privacyRepo.beginDeletionTargetAttempt(key);
          await memory.clean(target.targetId);
          const evidence = await memory.verify(target.targetId);
          await ctx.privacyRepo.updateDeletionTargetStatus(key, "completed", evidence);
        } catch (error) {
          await ctx.privacyRepo.updateDeletionTargetStatus(key, "failed");
          throw error;
        }
      }
      // All explicit targets have fresh proof, including targets completed by a previous retry.
      await ctx.platformRepo.createAuditRecord(local, {
        id: `aud_${crypto.randomUUID()}`, actorType: "system", actorId: `deletion:${ctx.workerId}`,
        action: "deletion.completed", subjectType: "deletion_request", subjectId: request.id,
        metadata: { scope: request.scope, verifier: MEMORY_DELETION_VERIFIER, targetCount: targets.length },
      });
      await ctx.privacyRepo.updateDeletionRequestStatus(local, request.id, "completed", {
        lastVerifiedAt: new Date().toISOString(), lastError: null,
      });
      completed += 1;
    } catch (error) {
      await ctx.privacyRepo.updateDeletionRequestStatus(local, request.id, "failed", {
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return completed;
}
