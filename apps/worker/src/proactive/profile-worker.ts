/**
 * CAP-033 本地画像提炼与原始副本保留周期。
 *
 * 顺序不变量：capture -> 原子提交本地结果、完成标记与回执 -> TTL purge。
 * 任何一步失败都保留原始副本；到期未提炼由仓储标为 blocked 并写本地告警。
 */
import type { IProactiveProfileRepository, LocalContext } from "@aervox/repositories";
import type { ProactiveCaptureDistiller } from "./distiller.js";

export interface ProactiveProfileWorkerContext {
  repo: Pick<IProactiveProfileRepository,
    "listDistillationCandidates" | "publishCaptureDistillation" | "markCaptureDistillationFailed" | "purgeEligibleCaptures">;
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

      const outputs = await deps.distiller.distill(capture);
      await deps.repo.publishCaptureDistillation(ctx, {
        captureId: capture.id, revisionId: capture.revisionId, sourceGrantId: capture.sourceGrantId,
        sourceKey: capture.sourceKey, checksum: capture.checksum, processorId: deps.distiller.processorId, outputs,
      });
      distilled += 1;
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
