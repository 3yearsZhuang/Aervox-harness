/**
 * Aervox｜思隅 @aervox/worker — 过期 Attempt 恢复 cycle（阶段 3b-B）
 *
 * 扫描 Running 且租约过期（lease_expires_at < now）的 Attempt：
 * - fencing +1：使残留在跑执行器的后续写入（finalize/renew）失效（单一终态与迟到结果丢弃）；
 * - 状态置 Interrupted：释放供用户重试（新请求新 Attempt）。
 *
 * 并回收「Turn 已提交但首个 Attempt 从未创建」的孤儿 Turn（无 Attempt → Interrupted + done，不自动重放）。
 *
 * 规则依据：AVX-HAR-001 §11.3 恢复。
 */
import { SqliteConversationRepository, type SqlitePrivacyRepository, type LocalContext } from "@aervox/repositories";
import type { AervoxDatabase } from "@aervox/repositories";
import type { Client } from "@libsql/client";
import type { ModelProviderPort } from "@aervox/core";
import { createSqliteResumeSource, resumeCommittedTurns, SqliteExecutionStore } from "@aervox/host-agent";

export interface AttemptRecoveryOptions {
  db: AervoxDatabase;
  client: Client;
  workerId: string;
  provider?: ModelProviderPort;
  privacyRepo?: SqlitePrivacyRepository;
}

export async function runAttemptRecoveryCycle(opts: AttemptRecoveryOptions): Promise<number> {
  const repo = new SqliteConversationRepository(opts.db);
  const localCtx: LocalContext = { workspaceId: "local", subjectUserId: "local" };

  // 1. 阶段 4：针对工具结果已提交的过期候选 Attempt，优先执行抢占式断点续跑（AVX-HAR-001 §11.3）
  const candidates = await repo.findResumeCandidates(opts.client);
  if (candidates.length > 0) {
    console.log(
      `[worker:${opts.workerId}] resume_candidates=${candidates.length} ${candidates.map((c) => `${c.attemptId}@${c.lastSequence}`).join(",")}`,
    );
    if (opts.provider) {
      const source = createSqliteResumeSource({ repo, client: opts.client });
      const deletionGate = {
        isBlocked: async (_t: { sessionId: string }) => {
          if (!opts.privacyRepo) return false;
          return opts.privacyRepo.hasPendingDeletionRequest(localCtx);
        },
      };
      try {
        const candidateMap = new Map(candidates.map((c) => [c.attemptId, c.turnId]));
        const resumedResults = await resumeCommittedTurns({
          source,
          createStore: () => new SqliteExecutionStore(repo, localCtx),
          createProvider: async () => opts.provider!,
          deletionGate,
          limit: 5,
        });
        for (const res of resumedResults) {
          if (res.status === "completed") {
            const turnId = candidateMap.get(res.attemptId);
            if (turnId) {
              await repo.updateTurnStatus(localCtx, turnId, "Completed").catch(() => undefined);
            }
          }
        }
      } catch (err) {
        console.error(`[worker:${opts.workerId}] resume_error:`, err);
      }
    }
  }

  // 2. 无法断点续跑或非候选的超时 Attempt，走安全熔断与状态收敛
  const recovered = await repo.recoverExpiredAttempts(opts.client);
  if (recovered > 0) {
    // 释放后遗留 pending 预留结果不可知（§11.3 unknown outcome，不自动重放）
    const unknown = await repo.markPendingOutcomeUnknown(opts.client);
    console.log(`[worker:${opts.workerId}] turn_attempt_recovery=${recovered} tool_outcome_unknown=${unknown}`);
  }

  // 3. 回收孤儿 Turn（无 Attempt → Interrupted + done 终态）
  const orphans = await repo.recoverOrphanTurns();
  if (orphans > 0) {
    console.log(`[worker:${opts.workerId}] orphan_turn_recovery=${orphans}`);
  }
  return recovered;
}