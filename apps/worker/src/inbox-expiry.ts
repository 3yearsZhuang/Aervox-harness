/**
 * Aervox｜思隅 @aervox/worker — Inbox 过期回收策略（阶段 5a-2）
 *
 * 规则依据：ADR-017「AgentInboxItem claim/ack + expiresAt 兜底回收」。
 * 跨租户把 expiresAt < now 且仍 pending/claimed 的收件箱项置为 expired：
 * - pending 过期：从未被消费，直接作废；
 * - claimed 过期：消费中崩溃未 ack，不再重放（避免陈旧注入）。
 */
import type { SqliteAgentInboxRepository } from "@aervox/database";

export interface InboxExpiryContext {
  inboxRepo: SqliteAgentInboxRepository;
}

/** 单次过期回收轮询；返回回收条数 */
export async function runInboxExpiryCycle(ctx: InboxExpiryContext): Promise<number> {
  return ctx.inboxRepo.expireOverdue();
}