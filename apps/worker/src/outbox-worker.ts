/**
 * Aervox｜思隅 @aervox/worker — Outbox 消费 Worker 骨架与调度器
 *
 * 规则依据：ADR-004 Outbox + 幂等作业；FND-01 消费归属与失败恢复。
 * 单用户本地环境消费 pending/retriable 事件，按事件类型分发或通用审计后标记发布；失败进入 retry/dead_letter。
 */
import type { LocalContext, OutboxEventModel, SqliteOutboxRepository, SqlitePlatformRepository } from "@aervox/repositories";
import { COMPACTION_EVENT_TYPE } from "./compaction-marker.js";

export type OutboxEventHandler = (
  event: OutboxEventModel,
  ctx: OutboxCycleContext,
) => Promise<void>;

export interface OutboxCycleContext {
  outboxRepo: SqliteOutboxRepository;
  platformRepo: SqlitePlatformRepository;
  workerId: string;
  limit?: number;
  maxRetries?: number;
  /** 已由独立 Worker 消费的事件类型列表，默认排除 COMPACTION_EVENT_TYPE 防止抢先完成 */
  excludeEventTypes?: string[];
  /** 自定义事件处理器；若配置则由特定处理器处理，成功后才标记 published */
  handlers?: Record<string, OutboxEventHandler>;
}

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/** 单次 Outbox 消费轮询 */
export async function runOutboxCycle(ctx: OutboxCycleContext): Promise<number> {
  const limit = ctx.limit ?? 50;
  const maxRetries = ctx.maxRetries ?? 3;
  // 若未指定 handlers，默认排除已有专用消费轮询的事件类型，杜绝通用循环抢先标记完成（FND-01）
  const excludeEventTypes = ctx.excludeEventTypes !== undefined
    ? ctx.excludeEventTypes
    : (ctx.handlers?.[COMPACTION_EVENT_TYPE] ? [] : [COMPACTION_EVENT_TYPE]);

  const events = await ctx.outboxRepo.fetchPendingEvents({
    limit,
    excludeEventTypes: excludeEventTypes.length > 0 ? excludeEventTypes : undefined,
    includeRetriable: true,
    maxRetries,
  });

  const localCtx: LocalContext = { workspaceId: "local", subjectUserId: "local" };

  for (const event of events) {
    try {
      // 1. 若注册了专用领域处理器，先执行业务消费逻辑（如压缩标记、日记投递等）
      const customHandler = ctx.handlers?.[event.eventType];
      if (customHandler) {
        await customHandler(event, ctx);
      } else {
        // 2. 通用兜底骨架：写入审计记录
        await ctx.platformRepo.createAuditRecord(localCtx, {
          id: id("aud"),
          actorType: "system",
          actorId: `outbox:${ctx.workerId}`,
          action: `outbox.consume.${event.eventType}`,
          subjectType: "outbox_event",
          subjectId: event.id,
          metadata: { workerId: ctx.workerId, eventType: event.eventType },
        });
      }
      // 3. 业务与审计成功后，才标记发布
      await ctx.outboxRepo.markPublished(event.id);
    } catch (err) {
      await ctx.outboxRepo.markFailed(
        event.id,
        err instanceof Error ? err.message : String(err),
        { maxRetries },
      );
    }
  }
  return events.length;
}
