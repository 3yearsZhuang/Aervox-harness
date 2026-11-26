/** Delete only explicitly supported targets; completion requires independent verification. */
import type { SqliteMemoryDeletionStore, DeletionQueuePort, DeletionRequestAttemptKey } from "@aervox/repositories";

export interface DeletionWorkerContext {
  memoryDeletion: Pick<SqliteMemoryDeletionStore, "clean" | "verify">;
  privacyRepo: DeletionQueuePort;
  workerId: string;
}

/** 删除拒绝原因码（稳定字符串；失败保持解闸关闭，供用户可见与审计） */
const DELETION_FAILURE_REASONS = {
  scopeUnsupported: "deletion_scope_unsupported",
  targetsEmpty: "deletion_targets_empty",
  targetUnsupported: "deletion_target_unsupported",
} as const;

/** Failed work is idempotently retried by later polling cycles and stays denied throughout. */
export async function runDeletionCycle(ctx: DeletionWorkerContext): Promise<number> {
  const requests = await ctx.privacyRepo.listUnverifiedDeletionRequests();
  const memory = ctx.memoryDeletion;
  let completed = 0;
  requestLoop: for (const request of requests) {
    let attempt: DeletionRequestAttemptKey | undefined;
    try {
      const claimed = await ctx.privacyRepo.beginDeletionRequestAttempt(request.id);
      if (!claimed) continue;
      attempt = { requestId: claimed.id, requestAttemptCount: claimed.attemptCount };
      const targets = await ctx.privacyRepo.listDeletionTargets(claimed.id);
      if (claimed.scope !== "memory" || claimed.ownerModule !== "memory") throw new Error(DELETION_FAILURE_REASONS.scopeUnsupported);
      if (!targets.length) throw new Error(DELETION_FAILURE_REASONS.targetsEmpty);
      // Validate the whole dispatch set before mutating any target.
      if (targets.some((t) => t.ownerModule !== "memory" || t.targetType !== "memory" || !t.targetId)) {
        throw new Error(DELETION_FAILURE_REASONS.targetUnsupported);
      }
      for (const target of targets) {
        const key = { ...attempt, targetType: target.targetType, targetId: target.targetId };
        if (!await ctx.privacyRepo.beginDeletionTargetAttempt(key)) continue requestLoop;
        try {
          await memory.clean(target.targetId);
          const evidence = await memory.verify(target.targetId);
          if (!await ctx.privacyRepo.updateDeletionTargetAttemptStatus(key, { status: "completed", evidenceRef: evidence })) continue requestLoop;
        } catch (error) {
          if (!await ctx.privacyRepo.updateDeletionTargetAttemptStatus(key, { status: "failed" })) continue requestLoop;
          throw error;
        }
      }
      if (await ctx.privacyRepo.finalizeDeletionRequestAttempt(attempt, ctx.workerId)) completed += 1;
    } catch (error) {
      if (attempt) await ctx.privacyRepo.failDeletionRequestAttempt(attempt, error instanceof Error ? error.message : String(error));
    }
  }
  return completed;
}
