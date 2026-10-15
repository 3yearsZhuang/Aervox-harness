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
import { SqliteConversationRepository } from "@aervox/repositories";
import type { AervoxDatabase } from "@aervox/repositories";
import type { Client } from "@libsql/client";

export interface AttemptRecoveryOptions {
  db: AervoxDatabase;
  client: Client;
  workerId: string;
  /** Explicit local-only recovery supplied by the shared product host. */
  resume?: () => Promise<unknown>;
}

export async function runAttemptRecoveryCycle(opts: AttemptRecoveryOptions): Promise<number> {
  const repo = new SqliteConversationRepository(opts.db);
  if (opts.resume) {
    try { await opts.resume(); }
    catch (error) { console.error(`[worker:${opts.workerId}] resume_error:`, error); }
  }
  const recovered = await repo.recoverExpiredAttempts(opts.client);
  if (recovered > 0) {
    const unknown = await repo.markPendingOutcomeUnknown(opts.client);
    console.log(`[worker:${opts.workerId}] turn_attempt_recovery=${recovered} tool_outcome_unknown=${unknown}`);
  }
  const orphans = await repo.recoverOrphanTurns();
  if (orphans > 0) console.log(`[worker:${opts.workerId}] orphan_turn_recovery=${orphans}`);
  return recovered;
}
