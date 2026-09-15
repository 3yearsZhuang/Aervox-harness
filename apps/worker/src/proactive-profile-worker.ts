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
} from "@aervox/schema";
import type {
  AervoxDatabase,
  IProactiveProfileRepository,
  ProactiveBehaviorObservationModel,
  ProactiveCaptureModel,
  ProactiveProfileClaimModel,
  LocalContext,
} from "@aervox/repositories";
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

function existingMemoryIds(
  claims: ProactiveProfileClaimModel[],
  capture: ProactiveCaptureModel,
): string[] {
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
    })
    .from(proactiveCaptures)
    .innerJoin(
      proactiveProfileRevisions,
      and(eq(proactiveProfileRevisions.id, proactiveCaptures.revisionId),
      ),
    )
    .innerJoin(
      proactiveSourceGrants,
      and(eq(proactiveSourceGrants.id, proactiveCaptures.sourceGrantId),
      ),
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

  const tenant: LocalContext = { workspaceId: "local", subjectUserId: "local" };
  // A candidate cycle used to rescan and decrypt the full capture/claim/
  // observation windows once per candidate. Cache those bounded windows for
  // the cycle; this changes the hot path from O(candidates * window) reads to
  // one read per revision/source while preserving the repository's existing
  // 500-row visibility contract.
  const captures = candidates.length > 0
    ? await ctx.repo.listCaptures(tenant, { includeDeleted: false, limit: 500 })
    : [];
  const capturesById = new Map(captures.map((capture) => [capture.id, capture]));
  const claimsByRevision = new Map<string, ProactiveProfileClaimModel[]>();
  const observationsByKey = new Map<string, ProactiveBehaviorObservationModel[]>();
  const claimsForRevision = async (revisionId: string): Promise<ProactiveProfileClaimModel[]> => {
    const cached = claimsByRevision.get(revisionId);
    if (cached) return cached;
    const loaded = await ctx.repo.listClaims(tenant, { revisionId, limit: 500 });
    claimsByRevision.set(revisionId, loaded);
    return loaded;
  };
  const observationsFor = async (revisionId: string, sourceKey: string): Promise<ProactiveBehaviorObservationModel[]> => {
    const key = `${revisionId}:${sourceKey}`;
    const cached = observationsByKey.get(key);
    if (cached) return cached;
    const loaded = await ctx.repo.listObservations(tenant, { revisionId, sourceKey, limit: 500 });
    observationsByKey.set(key, loaded);
    return loaded;
  };

  let distilled = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const capture = capturesById.get(candidate.id) ?? null;
      if (!capture) continue;

      // Crash recovery: claims may already exist if the previous process stopped between
      // claim creation and capture finalization. Reuse them instead of duplicating memory.
      const claims = await claimsForRevision(capture.revisionId);
      let memoryIds = existingMemoryIds(claims, capture);
      if (memoryIds.length === 0) {
        const memories = await ctx.distiller.distill(capture);
        if (memories.length === 0) throw new Error("local distiller produced no profile memory");
        const existingObservations = await observationsFor(capture.revisionId, capture.sourceKey);
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
                // CR-032：结构化证据直通（idle_state 等元数据级样本）
                ...(memory.structured ?? {}),
              },
              checksum: capture.checksum,
              algorithmVersion: ctx.distiller.processorId,
              observedAt: capture.observedAt,
              normalizedAt: nowIso,
            });
          if (!existingObservations.some((item) => item.id === observation.id)) {
            existingObservations.push(observation);
          }
          // CR-032：observationOnly 样本（idle_state 等元数据级高频源）不进 claim 审阅流
          if (memory.observationOnly) {
            memoryIds.push(observation.id);
            continue;
          }
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
          claims.push(claim);
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
