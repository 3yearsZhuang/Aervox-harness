/**
 * Aervox｜思隅 @aervox/worker — 上下文压缩标记异步消费（T-03 接线）
 *
 * 消费 outbox 中 `memory.compaction.requested` 事件，把「临时→短期整理」产生的
 * 摘要/快照锚点幂等落库为 memory_compaction_markers（同一 memoryId+snapshotId
 * 不重复写入），并联动 memory_events 审计（action=compressed）。
 *
 * 事件载荷约定（payload）：
 * { memoryId, snapshotId, coveredUpToMessageId?, summaryText?, thoughtDurationMs?, summaryDurationMs? }
 *
 * 规则依据：docs/explanation/reference-design-transfer.md §3.3（先写后投递：
 * 仅在完整响应持久化后投递该事件）。
 */
import type {
  SqliteMemoryCompactionRepository,
  SqliteOutboxRepository,
} from "@aervox/database";

export const COMPACTION_EVENT_TYPE = "memory.compaction.requested";

export interface CompactionMarkerContext {
  outboxRepo: SqliteOutboxRepository;
  compactionRepo: SqliteMemoryCompactionRepository;
  workerId: string;
  /** 每轮最多处理事件数，默认 50 */
  limit?: number;
}

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

/** 单次消费；返回成功落库的标记数 */
export async function runCompactionMarkerCycle(ctx: CompactionMarkerContext): Promise<number> {
  const events = await ctx.outboxRepo.fetchPendingEvents(ctx.limit ?? 50);
  let markers = 0;

  for (const event of events) {
    if (event.eventType !== COMPACTION_EVENT_TYPE) continue;

    const tenant = { workspaceId: event.workspaceId, subjectUserId: event.subjectUserId };
    const payload = (event.payload ?? {}) as {
      memoryId?: string;
      snapshotId?: string;
      coveredUpToMessageId?: string | null;
      summaryText?: string | null;
      thoughtDurationMs?: number | null;
      summaryDurationMs?: number | null;
    };

    try {
      if (!payload.memoryId || !payload.snapshotId) {
        throw new Error("compaction event payload missing memoryId/snapshotId");
      }
      await ctx.compactionRepo.upsertMarker(tenant, {
        id: id("mark"),
        memoryId: payload.memoryId,
        snapshotId: payload.snapshotId,
        coveredUpToMessageId: payload.coveredUpToMessageId ?? null,
        summaryText: payload.summaryText ?? null,
        phase: "auto",
        status: "completed",
        thoughtDurationMs: payload.thoughtDurationMs ?? null,
        summaryDurationMs: payload.summaryDurationMs ?? null,
      });
      await ctx.compactionRepo.recordEvent(tenant, {
        id: id("evt"),
        memoryId: payload.memoryId,
        action: "compressed",
        reason: `auto compaction from outbox:${event.id}`,
        actorType: `worker:${ctx.workerId}`,
      });
      await ctx.outboxRepo.markPublished(event.id);
      markers += 1;
    } catch (err) {
      await ctx.outboxRepo.markFailed(
        event.id,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return markers;
}