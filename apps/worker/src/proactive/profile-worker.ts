/**
 * CAP-033 本地画像提炼与原始副本保留周期。
 *
 * 顺序不变量：capture -> local claim memory -> mark distilled -> TTL purge。
 * 任何一步失败都保留原始副本；到期未提炼由仓储标为 blocked 并写本地告警。
 */
import type { IProactiveProfileRepository, LocalContext } from "@aervox/repositories";
import type { ProactiveCaptureDistiller } from "./distiller.js";

export interface ProactiveProfileWorkerContext {
  repo: Pick<IProactiveProfileRepository,
    "listDistillationCandidates" | "listCaptureClaims" | "createObservation" | "createClaim"
    | "markCaptureDistilled" | "markCaptureDistillationFailed" | "purgeEligibleCaptures">;
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

/** 单次本地画像周期；返回各阶段处理数量。 */
export async function runProactiveProfileCycle(
  deps: ProactiveProfileWorkerContext,
): Promise<ProactiveProfileCycleResult> {
  const now = (deps.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const retryBefore = new Date(now.getTime() - 5 * 60 * 1000).toISOString();
  const ctx: LocalContext = { workspaceId: "local", subjectUserId: "local" };
  const candidates = await deps.repo.listDistillationCandidates(ctx, { retryBefore, limit: clampLimit(deps.limit) });

  let distilled = 0;
  let failed = 0;
  for (const candidate of candidates) {
    try {
      const capture = candidate;

      // Crash recovery: claims may already exist if the previous process stopped between
      // claim creation and capture finalization. Reuse them instead of duplicating memory.
      const claims = await deps.repo.listCaptureClaims(ctx, capture.id);
      let memoryIds = claims.map(claim => claim.id);
      if (memoryIds.length === 0) {
        const memories = await deps.distiller.distill(capture);
        if (memories.length === 0) throw new Error("local distiller produced no profile memory");
        memoryIds = [];
        for (let index = 0; index < memories.length; index += 1) {
          const memory = memories[index]!;
          const observationId = `pobs_${capture.id}_${index + 1}`;
          const observation = await deps.repo.createObservation(ctx, {
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
            algorithmVersion: deps.distiller.processorId,
            observedAt: capture.observedAt,
            normalizedAt: nowIso,
          });
          // CR-032：observationOnly 样本（idle_state 等元数据级高频源）不进 claim 审阅流
          if (memory.observationOnly) {
            memoryIds.push(observation.id);
            continue;
          }
          const claimId = `pclaim_${capture.id}_${index + 1}`;
          const claim = await deps.repo.createClaim(ctx, {
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
      const updated = await deps.repo.markCaptureDistilled(ctx, capture.id, memoryIds);
      if (updated) distilled += 1;
    } catch (error) {
      failed += 1;
      const reason = error instanceof Error ? error.message : String(error);
      await deps.repo
        .markCaptureDistillationFailed(ctx, candidate.id, reason.slice(0, 500))
        .catch(() => undefined);
    }
  }

  // This method first blocks overdue undistilled captures, then clears only distilled rows.
  const purged = await deps.repo.purgeEligibleCaptures(undefined, nowIso, clampLimit(deps.limit));
  return { distilled, failed, purged };
}
