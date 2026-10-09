/**
 * Aervox｜思隅 @aervox/repositories — 事务 Outbox SQLite 仓储实现
 *
 * 规则依据：ADR-004 + ADR-013
 */
import { eq, and, or, lt, sql, notInArray } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { outboxEvents } from "@aervox/schema";
import type { LocalContext } from "../../local-context.js";
import type { FetchPendingEventsOptions, IOutboxRepository, OutboxEventModel } from "../types/index.js";
import { notifyWorkerWakeup } from "../../worker-ipc.js";
import { assertMemoryCompactionAvailable, MEMORY_COMPACTION_EVENT_TYPE, MemoryCompactionUnavailableError } from "./memory-compaction-guard.js";

export class SqliteOutboxRepository implements IOutboxRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async insertEvent(
    ctx: LocalContext,
    eventData: {
      id: string;
      idempotencyKey: string;
      eventType: string;
      payload: unknown;
      controlEventId?: string | null;
    },
  ): Promise<OutboxEventModel> {
    const now = new Date().toISOString();
    const insert = async (db: Pick<AervoxDatabase, "insert">) => db
      .insert(outboxEvents)
      .values({
        id: eventData.id,
        controlEventId: eventData.controlEventId ?? null,
        idempotencyKey: eventData.idempotencyKey,
        eventType: eventData.eventType,
        payload: eventData.payload,
        status: "pending",
        retryCount: 0,
        createdAt: now,
      })
      .returning();
    const [created] = eventData.eventType === MEMORY_COMPACTION_EVENT_TYPE
      ? await this.db.transaction(async (tx) => {
          const memoryId = (eventData.payload as { memoryId?: unknown } | null)?.memoryId;
          if (typeof memoryId !== "string") throw new MemoryCompactionUnavailableError();
          await assertMemoryCompactionAvailable(tx, memoryId);
          return insert(tx);
        })
      : await insert(this.db);

    // 事务提交后触发跨进程 Worker IPC 秒级唤醒（尽力而为：不 await、不抛出，Worker 未启动
    // 或 socket 不可达时返回 false，由 Worker 的轮询兜底，不阻塞本写入路径）。
    void notifyWorkerWakeup("outbox");

    return created as OutboxEventModel;
  }

  async fetchPendingEvents(
    optionsOrLimit?: number | FetchPendingEventsOptions,
  ): Promise<OutboxEventModel[]> {
    const opts: FetchPendingEventsOptions =
      typeof optionsOrLimit === "number"
        ? { limit: optionsOrLimit }
        : (optionsOrLimit ?? {});
    const limit = opts.limit ?? 50;
    const maxRetries = opts.maxRetries ?? 3;

    const conditions = [];

    if (opts.includeRetriable) {
      conditions.push(
        or(
          eq(outboxEvents.status, "pending"),
          and(
            eq(outboxEvents.status, "failed"),
            lt(outboxEvents.retryCount, maxRetries),
          ),
        ),
      );
    } else {
      conditions.push(eq(outboxEvents.status, "pending"));
    }

    if (opts.eventType) {
      conditions.push(eq(outboxEvents.eventType, opts.eventType));
    }

    if (opts.excludeEventTypes && opts.excludeEventTypes.length > 0) {
      conditions.push(notInArray(outboxEvents.eventType, opts.excludeEventTypes));
    }

    const rows = await this.db
      .select()
      .from(outboxEvents)
      .where(and(...conditions))
      .orderBy(outboxEvents.createdAt)
      .limit(limit);
    return rows as OutboxEventModel[];
  }

  async markPublished(eventId: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .update(outboxEvents)
      .set({
        status: "published",
        publishedAt: now,
      })
      .where(eq(outboxEvents.id, eventId));
  }

  async markFailed(
    eventId: string,
    error: string,
    options?: { maxRetries?: number },
  ): Promise<{ status: "failed" | "dead_letter"; retryCount: number } | null> {
    const maxRetries = options?.maxRetries ?? 3;
    const [updated] = await this.db
      .update(outboxEvents)
      .set({
        retryCount: sql`${outboxEvents.retryCount} + 1`,
        status: sql`CASE WHEN ${outboxEvents.retryCount} + 1 >= ${maxRetries} THEN 'dead_letter' ELSE 'failed' END`,
        lastError: error,
      })
      .where(eq(outboxEvents.id, eventId))
      .returning();
    return (updated as { status: "failed" | "dead_letter"; retryCount: number }) ?? null;
  }

  async markDeadLetter(eventId: string, reason: string): Promise<void> {
    await this.db
      .update(outboxEvents)
      .set({
        status: "dead_letter",
        lastError: reason,
      })
      .where(eq(outboxEvents.id, eventId));
  }

  async getEventById(eventId: string): Promise<OutboxEventModel | null> {
    const [found] = await this.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, eventId))
      .limit(1);
    return (found as OutboxEventModel) ?? null;
  }
}
