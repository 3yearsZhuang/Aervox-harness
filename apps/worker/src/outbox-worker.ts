/**
 * Aervox｜思隅 @aervox/worker — Outbox 消费 Worker 骨架
 *
 * 规则依据：ADR-004 Outbox + 幂等作业。
 * 跨租户消费 pending 事件，逐条审计后标记发布；失败进入 retry/dead_letter。
 */
import type { SqliteOutboxRepository, SqlitePlatformRepository } from "@aervox/database";

export interface OutboxCycleContext {
  outboxRepo: SqliteOutboxRepository;
  platformRepo: SqlitePlatformRepository;
  workerId: string;
}

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/** 单次 Outbox 消费轮询 */
export async function runOutboxCycle(ctx: OutboxCycleContext): Promise<number> {
  const events = await ctx.outboxRepo.fetchPendingEvents(50);
  for (const event of events) {
    const tenant = { workspaceId: event.workspaceId, subjectUserId: event.subjectUserId };
    try {
      // 消费骨架：写入审计后标记发布（具体下游处理按 eventType 扩展）
      await ctx.platformRepo.createAuditRecord(tenant, {
        id: id("aud"),
        actorType: "system",
        actorId: `outbox:${ctx.workerId}`,
        action: `outbox.consume.${event.eventType}`,
        subjectType: "outbox_event",
        subjectId: event.id,
        metadata: { workerId: ctx.workerId, eventType: event.eventType },
      });
      await ctx.outboxRepo.markPublished(event.id);
    } catch (err) {
      await ctx.outboxRepo.markFailed(event.id, err instanceof Error ? err.message : String(err));
    }
  }
  return events.length;
}
