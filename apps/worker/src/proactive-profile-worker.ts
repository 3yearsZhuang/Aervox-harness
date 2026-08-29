/**
 * CAP-033 本地画像提炼与原始副本保留周期。
 *
 * 顺序不变量：capture -> local claim memory -> mark distilled -> TTL purge。
 * 任何一步失败都保留原始副本；到期未提炼由仓储标为 blocked 并写本地告警。
 */
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import {
  proactiveCaptures,
  proactiveProfileRevisions,
  proactiveSourceGrants,
  type AervoxDatabase,
  type IProactiveProfileRepository,
  type ProactiveCaptureModel,
  type TenantContext,
} from "@aervox/database";
import type { ProactiveCaptureDistiller } from "./proactive-distiller.js";

export interface ProactiveProfileWorkerContext {
  db: AervoxDatabase;
  repo: IProactiveProfileRepository;
  distiller: ProactiveCaptureDistiller;
  workerId: string;
  limit?: number;
  now?: () => Date;
}

export interface ProactiveProfileCycleResult {
  distilled: number;
  failed: number;
  purged: number;
}

const clampLimit = (value: number | undefined): number =>
  Math.max(1, Math.min(200, Math.floor(value ?? 50)));

async function loadCapture(
  repo: IProactiveProfileRepository,
  tenant: TenantContext,
  captureId: string,
): Promise<ProactiveCaptureModel | null> {
  const captures = await repo.listCaptures(tenant, { includeDeleted: false, limit: 500 });
  return captures.find((capture) => capture.id === captureId) ?? null;
}

async function existingMemoryIds(
  repo: IProactiveProfileRepository,
  tenant: TenantContext,
  capture: ProactiveCaptureModel,
): Promise<string[]> {
  const claims = await repo.listClaims(tenant, { revisionId: capture.revisionId, limit: 500 });
  return claims
    .filter((claim) => claim.evidenceCaptureIds.includes(capture.id))
    .map((claim) => claim.id);
}

/** 单次本地画像周期；返回各阶段处理数量。 */
export async function runProactiveProfileCycle(
  ctx: ProactiveProfileWorkerContext,
): Promise<ProactiveProfileCycleResult> {
  const now = (ctx.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const retryBefore = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const candidates = await ctx.db
    .select({
      id: proactiveCaptures.id,
      workspaceId: proactiveCaptures.workspaceId,
      subjectUserId: proactiveCaptures.subjectUserId,
    })
    .from(proactiveCaptures)
    .innerJoin(
      proactiveProfileRevisions,
      and(eq(proactiveProfileRevisions.id, proactiveCaptures.revisionId),
        eq(proactiveProfileRevisions.workspaceId, proactiveCaptures.workspaceId),
        eq(proactiveProfileRevisions.subjectUserId, proactiveCaptures.subjectUserId)),
    )
    .innerJoin(
      proactiveSourceGrants,
      and(eq(proactiveSourceGrants.id, proactiveCaptures.sourceGrantId),
        eq(proactiveSourceGrants.workspaceId, proactiveCaptures.workspaceId),
        eq(proactiveSourceGrants.subjectUserId, proactiveCaptures.subjectUserId)),
    )
    .where(
      and(
        isNull(proactiveCaptures.deletedAt),
        eq(proactiveProfileRevisions.status, "active"),
        eq(proactiveProfileRevisions.desiredState, "enabled"),
        eq(proactiveSourceGrants.state, "granted"),
        or(
          eq(proactiveCaptures.distillationStatus, "pending"),
          and(
            inArray(proactiveCaptures.distillationStatus, ["failed", "blocked"]),
            lte(proactiveCaptures.updatedAt, retryBefore),
          ),
        ),
      ),
    )
    .orderBy(asc(proactiveCaptures.ingestedAt))
    .limit(clampLimit(ctx.limit));

  let distilled = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const tenant: TenantContext = {
      workspaceId: candidate.workspaceId,
      subjectUserId: candidate.subjectUserId,
    };
    try {
      const capture = await loadCapture(ctx.repo, tenant, candidate.id);
      if (!capture) continue;

      // Crash recovery: claims may already exist if the previous process stopped between
      // claim creation and capture finalization. Reuse them instead of duplicating memory.
      let memoryIds = await existingMemoryIds(ctx.repo, tenant, capture);
      if (memoryIds.length === 0) {
        const memories = await ctx.distiller.distill(capture);
        if (memories.length === 0) throw new Error("local distiller produced no profile memory");
        const existingObservations = await ctx.repo.listObservations(tenant, {
          revisionId: capture.revisionId,
          sourceKey: capture.sourceKey,
          limit: 500,
        });
        memoryIds = [];
        for (let index = 0; index < memories.length; index += 1) {
          const memory = memories[index]!;
          const observationId = `pobs_${capture.id}_${index + 1}`;
          const observation = existingObservations.find((item) => item.id === observationId)
            ?? await ctx.repo.createObservation(tenant, {
              id: observationId,
              revisionId: capture.revisionId,
              sourceGrantId: capture.sourceGrantId,
              sourceKey: capture.sourceKey,
              observationType: memory.claimType,
              subjectKey: memory.subjectKey,
              payload: {
                captureId: capture.id,
                content: memory.content,
                confidence: memory.confidence,
                evidenceRefs: memory.evidenceRefs,
              },
              checksum: capture.checksum,
              algorithmVersion: ctx.distiller.processorId,
              observedAt: capture.observedAt,
              normalizedAt: nowIso,
            });
          const claimId = `pclaim_${capture.id}_${index + 1}`;
          const claim = await ctx.repo.createClaim(tenant, {
            id: claimId,
            revisionId: capture.revisionId,
            claimType: memory.claimType,
            subjectKey: memory.subjectKey,
            content: memory.content,
            state: "inferred",
            confidence: memory.confidence,
            evidenceCaptureIds: [capture.id],
            evidenceRefs: [
              ...memory.evidenceRefs,
              { observationId: observation.id, algorithmVersion: observation.algorithmVersion },
            ],
            sourceGrantIds: [capture.sourceGrantId],
          });
          memoryIds.push(claim.id);
        }
      }
      const updated = await ctx.repo.markCaptureDistilled(tenant, capture.id, memoryIds);
      if (updated) distilled += 1;
    } catch (error) {
      failed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      await ctx.repo
        .markCaptureDistillationFailed(tenant, candidate.id, reason.slice(0, 500))
        .catch(() => undefined);
    }
  }

  // This method first blocks overdue undistilled captures, then clears only distilled rows.
  const purged = await ctx.repo.purgeEligibleCaptures(undefined, nowIso, clampLimit(ctx.limit));
  return { distilled, failed, purged };
}
