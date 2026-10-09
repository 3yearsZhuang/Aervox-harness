/** Delete only explicitly supported targets; completion requires independent verification. */
import { eq, sql } from "drizzle-orm";
import { deletionRequests, deletionTargets } from "@aervox/schema";
import { SqliteMemoryDeletionStore, unverifiedDeletionRequest, type AervoxDatabase, type SqlitePrivacyRepository, type SqlitePlatformRepository } from "@aervox/repositories";

export interface DeletionWorkerContext {
  db: AervoxDatabase;
  privacyRepo: SqlitePrivacyRepository;
  platformRepo: SqlitePlatformRepository;
  workerId: string;
}
const local = { workspaceId: "local", subjectUserId: "local" };

/** Failed work is idempotently retried by later polling cycles and stays denied throughout. */
export async function runDeletionCycle(ctx: DeletionWorkerContext): Promise<number> {
  const requests = await ctx.db.select().from(deletionRequests)
    .where(unverifiedDeletionRequest)
    .orderBy(deletionRequests.updatedAt).limit(20);
  const memory = new SqliteMemoryDeletionStore(ctx.db);
  let completed = 0;
  for (const request of requests) {
    try {
      await ctx.privacyRepo.updateDeletionRequestStatus(local, request.id, "in_progress", {
        attemptCount: request.attemptCount + 1, lastError: null,
      });
      const targets = await ctx.db.select().from(deletionTargets).where(eq(deletionTargets.requestId, request.id));
      if (request.scope !== "memory" || request.ownerModule !== "memory") throw new Error("deletion_scope_unsupported");
      if (!targets.length) throw new Error("deletion_targets_empty");
      // Validate the whole dispatch set before mutating any target.
      if (targets.some((t) => t.ownerModule !== "memory" || t.targetType !== "memory" || !t.targetId)) {
        throw new Error("deletion_target_unsupported");
      }
      for (const target of targets) {
        const key = { requestId: request.id, targetType: target.targetType, targetId: target.targetId };
        try {
          await ctx.privacyRepo.updateDeletionTargetStatus(key, "in_progress");
          await ctx.db.update(deletionTargets).set({ attemptCount: sql`${deletionTargets.attemptCount} + 1` })
            .where(sql`${deletionTargets.requestId} = ${request.id} AND ${deletionTargets.targetType} = ${target.targetType} AND ${deletionTargets.targetId} = ${target.targetId}`);
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
        metadata: { scope: request.scope, verifier: "memory-local-v2", targetCount: targets.length },
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
