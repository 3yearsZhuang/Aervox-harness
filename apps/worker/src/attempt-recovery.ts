/**
 * Aervox｜思隅 @aervox/worker — 过期 Attempt 恢复 cycle（阶段 3b-B）
 *
 * 扫描 Running 且租约过期（lease_expires_at < now）的 Attempt：
 * - fencing +1：使残留在跑执行器的后续写入（finalize/renew）失效（单一终态与迟到结果丢弃）；
 * - 状态置 Interrupted：释放供用户重试（新请求新 Attempt）。
 *
 * 规则依据：AVX-HAR-001 §11.3 恢复。
 */
import { SqliteConversationRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import type { Client } from "@libsql/client";

export async function runAttemptRecoveryCycle(opts: {
  db: AervoxDatabase;
  client: Client;
  workerId: string;
}): Promise<number> {
  const repo = new SqliteConversationRepository(opts.db);
  const recovered = await repo.recoverExpiredAttempts(opts.client);
  if (recovered > 0) {
    console.log(`[worker:${opts.workerId}] turn_attempt_recovery=${recovered}`);
  }
  return recovered;
}