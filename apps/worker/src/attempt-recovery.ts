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
import type { ConversationHost } from "@aervox/host-runtime";

export interface AttemptRecoveryOptions {
  commands: Pick<ConversationHost["commands"], "recoverStaleExecutions">;
  workerId: string;
}

export async function runAttemptRecoveryCycle(opts: AttemptRecoveryOptions): Promise<number> {
  const result = await opts.commands.recoverStaleExecutions();
  if (result.resumeFailed) console.error(`[worker:${opts.workerId}] resume_error: local-result resume failed`);
  if (result.recoveredAttempts > 0) {
    console.log(`[worker:${opts.workerId}] turn_attempt_recovery=${result.recoveredAttempts} tool_outcome_unknown=${result.unknownOutcomes}`);
  }
  if (result.orphanTurns > 0) console.log(`[worker:${opts.workerId}] orphan_turn_recovery=${result.orphanTurns}`);
  return result.recoveredAttempts;
}
