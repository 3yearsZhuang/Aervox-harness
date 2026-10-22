/**
 * Aervox｜思隅 @aervox/repositories — Turn 流事件（fencing CAS）Store
 */
import { eq, and, gt, lte, desc, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import { turnStreamEvents, turnAttempts } from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import { FencingMismatchError } from "../../../errors.js";
import type { TurnStreamEventModel, TurnStreamEventPageOptions, TurnStreamEventPage } from "../../types/index.js";

export const MAX_STREAM_EVENT_PAGE_ROWS = 256;
export const MAX_STREAM_EVENT_PAGE_DATA_BYTES = 256 * 1024;

/** Turn 内 sequence 唯一，因此可构造跨进程稳定、可重连复用的事件标识。 */
export const streamEventId = (turnId: string, sequence: number): string => `tev_${turnId}_${sequence}`;

export class StreamEventStore {
  constructor(private readonly db: AervoxDatabase) {}

  async appendStreamEvent(
    ctx: LocalContext,
    eventData: {
      id: string;
      turnId: string;
      sequence: number;
      eventType: string;
      payloadVersion?: number;
      data: unknown;
      occurredAt?: string;
      attemptId?: string | null;
      safetyDecision?: string | null;
      committedAt?: string | null;
      /**
       * 3c+（B1）：事件写入 fencing CAS 校验。仅当 attemptId 与本字段同时给出时启用：
       * 要求对应 turn_attempts 行存在、fencing_token 与期望一致，且状态允许
       * （Running/CancelRequested，或终态下仅收尾的 done/error 事件——终态提交先于
       * done 的路径需要）。被抢占/恢复的执行器（fencing 已递增）写入将被拒绝并抛
       * FencingMismatchError（AVX-HAR-001 §11.2/§12.2）。
       */
      expectedFencingToken?: number | null;
    },
  ): Promise<TurnStreamEventModel> {
    const fenced =
      eventData.attemptId != null && eventData.expectedFencingToken != null;
    // BEGIN IMMEDIATE：fencing 校验与插入在同一写锁内原子完成，
    // 杜绝「SELECT 校验通过 → 他方抢占提交 → 本事务再插入」的窗口（B1 CAS）。
    return this.db.transaction(
      async (tx) => {
        if (fenced) {
          const [attempt] = await tx
            .select({ status: turnAttempts.status, fencingToken: turnAttempts.fencingToken })
            .from(turnAttempts)
            .where(
              and(
                eq(turnAttempts.id, eventData.attemptId as string),
                eq(turnAttempts.turnId, eventData.turnId),
              ),
            );
          const running = attempt && (attempt.status === "Running" || attempt.status === "CancelRequested");
          const terminalDoneOk =
            attempt &&
            (eventData.eventType === "done" || eventData.eventType === "error") &&
            ["Completed", "Failed", "Interrupted", "Cancelled"].includes(attempt.status);
          if (
            !attempt ||
            attempt.fencingToken !== eventData.expectedFencingToken ||
            !(running || terminalDoneOk)
          ) {
            throw new FencingMismatchError(
              `attempt ${eventData.attemptId} fencing=${attempt?.fencingToken ?? "?"} status=${attempt?.status ?? "?"} cannot append ${eventData.eventType}`,
            );
          }
        }
        const [created] = await tx
          .insert(turnStreamEvents)
          .values({
            id: eventData.id,
            turnId: eventData.turnId,
            sequence: eventData.sequence,
            eventType: eventData.eventType,
            payloadVersion: eventData.payloadVersion ?? 1,
            data: eventData.data,
            occurredAt: eventData.occurredAt ?? new Date().toISOString(),
            attemptId: eventData.attemptId ?? null,
            safetyDecision: eventData.safetyDecision ?? null,
            committedAt: eventData.committedAt ?? null,
          })
          .returning();
        return created as TurnStreamEventModel;
      },
      { behavior: "immediate" },
    );
  }

  async getStreamEvents(
    ctx: LocalContext,
    turnId: string,
    afterSequence: number = 0,
  ): Promise<TurnStreamEventModel[]> {
    const rows = await this.db
      .select()
      .from(turnStreamEvents)
      .where(
        and(
          eq(turnStreamEvents.turnId, turnId),
          gt(turnStreamEvents.sequence, afterSequence),
        ),
      )
      .orderBy(turnStreamEvents.sequence);
    return rows as TurnStreamEventModel[];
  }

  async getStreamEventById(
    ctx: LocalContext,
    turnId: string,
    eventId: string,
  ): Promise<TurnStreamEventModel | null> {
    const [row] = await this.db
      .select()
      .from(turnStreamEvents)
      .where(and(
        eq(turnStreamEvents.turnId, turnId),
        eq(turnStreamEvents.id, eventId),
      ))
      .limit(1);
    return (row as TurnStreamEventModel | undefined) ?? null;
  }

  async getStreamEventHighWater(ctx: LocalContext, turnId: string): Promise<number> {
    const [row] = await this.db.select({ sequence: turnStreamEvents.sequence })
      .from(turnStreamEvents).where(eq(turnStreamEvents.turnId, turnId))
      .orderBy(desc(turnStreamEvents.sequence)).limit(1);
    return row?.sequence ?? 0;
  }

  async getStreamEventsPage(
    ctx: LocalContext,
    turnId: string,
    options: TurnStreamEventPageOptions,
  ): Promise<TurnStreamEventPage> {
    const after = options.afterSequence ?? 0;
    if (!Number.isSafeInteger(after) || after < 0 ||
        !Number.isSafeInteger(options.throughSequence) || options.throughSequence < 0) {
      throw new RangeError("invalid_stream_event_page_sequence");
    }
    const limit = options.limit === undefined ? MAX_STREAM_EVENT_PAGE_ROWS
      : Math.min(MAX_STREAM_EVENT_PAGE_ROWS, Math.max(1, Math.floor(options.limit)));
    if (!Number.isFinite(limit)) throw new RangeError("invalid_stream_event_page_limit");
    // Read only bounded metadata first: applying a byte budget after loading all
    // JSON rows would still materialize an arbitrarily large 256-event page.
    const candidates = await this.db.select({
      sequence: turnStreamEvents.sequence,
      dataBytes: sql<number>`length(cast(${turnStreamEvents.data} as blob))`,
    }).from(turnStreamEvents).where(and(
      eq(turnStreamEvents.turnId, turnId),
      gt(turnStreamEvents.sequence, after),
      lte(turnStreamEvents.sequence, options.throughSequence),
    )).orderBy(turnStreamEvents.sequence).limit(limit);
    let persistedDataBytes = 0;
    let lastSequence = after;
    for (const row of candidates) {
      const bytes = Number(row.dataBytes);
      if (lastSequence !== after && persistedDataBytes + bytes > MAX_STREAM_EVENT_PAGE_DATA_BYTES) break;
      persistedDataBytes += bytes;
      lastSequence = row.sequence;
      if (persistedDataBytes >= MAX_STREAM_EVENT_PAGE_DATA_BYTES) break;
    }
    if (lastSequence === after) return { events: [], persistedDataBytes: 0, oversizedEvent: false };
    const events = await this.db.select().from(turnStreamEvents).where(and(
      eq(turnStreamEvents.turnId, turnId), gt(turnStreamEvents.sequence, after),
      lte(turnStreamEvents.sequence, lastSequence),
    )).orderBy(turnStreamEvents.sequence).limit(limit);
    return {
      events: events as TurnStreamEventModel[], persistedDataBytes,
      oversizedEvent: persistedDataBytes > MAX_STREAM_EVENT_PAGE_DATA_BYTES,
    };
  }

  async recordTurnStreamEvent(
    ctx: LocalContext,
    eventData: {
      id?: string;
      turnId: string;
      sequence: number;
      eventType: string;
      payloadVersion?: number;
      data: unknown;
      occurredAt?: string;
      attemptId?: string | null;
      safetyDecision?: string | null;
      committedAt?: string | null;
    },
  ): Promise<TurnStreamEventModel> {
    return this.appendStreamEvent(ctx, {
      ...eventData,
      id: eventData.id || `tev_${eventData.turnId}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    });
  }
}
