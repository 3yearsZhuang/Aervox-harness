/**
 * Aervox｜思隅 @aervox/repositories — Turn 流事件（fencing CAS）Store
 */
import { eq, and, gt, lte, desc, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import { turnStreamEvents, turnAttempts, deletionRequests, turns, sessions, messageVersions, messages, conversationExecutionPolicies } from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import { assertPluginGeneration, type PluginGenerationIdentity } from "../../../plugin-generation-guard.js";
import { unverifiedDeletionRequest } from "../privacy-repository.js";
import { FencingMismatchError } from "../../../errors.js";
import { conversationDispatchTarget } from "../../../conversation-execution-policy.js";
import type { TurnStreamEventModel, TurnStreamEventPageOptions, TurnStreamEventPage, TurnStreamReplayState } from "../../types/index.js";

export const MAX_STREAM_EVENT_PAGE_ROWS = 256;
export const MAX_STREAM_EVENT_PAGE_DATA_BYTES = 256 * 1024;

/** Turn 内 sequence 唯一，因此可构造跨进程稳定、可重连复用的事件标识。 */
export const streamEventId = (turnId: string, sequence: number): string => `tev_${turnId}_${sequence}`;

// Only the online transport uses this predicate. Legacy accepted input may have
// no Message identity, but its version 1 must still exist: a later edited version
// cannot replace a physically deleted source. Related identities are checked for
// soft deletion. isRedacted excludes extraction and also marks the fixed crisis
// response; it is not an independent online disclosure decision.
const validStreamPolicy = sql.join(conversationExecutionPolicies.map(policy => sql`(
  ${turns.executionPolicy} = ${policy} and ${turns.dispatchTarget} = ${conversationDispatchTarget(policy)}
)`), sql` or `);
const disclosableTurn = (turnId: string) => sql`exists (
  select 1 from ${turns} inner join ${sessions} on ${sessions.id} = ${turns.sessionId}
  where ${turns.id} = ${turnId}
    and ${turns.executionPolicy} = ${sessions.executionPolicy} and (${validStreamPolicy})
    and exists (select 1 from ${messageVersions}
      where ${messageVersions.turnId} = ${turnId}
        and ${messageVersions.role} = 'user' and ${messageVersions.version} = 1)
    and not exists (select 1 from ${messageVersions}
      where ${messageVersions.turnId} = ${turnId}
        and exists (select 1 from ${messages}
          where ${messages.deletedAt} is not null and (
            ${messages.id} = ${messageVersions.messageId}
            or ${messages.id} = ${messageVersions.id}
            or ${messages.currentVersionId} = ${messageVersions.id}
          )))
)`;

export class StreamEventStore {
  constructor(private readonly db: AervoxDatabase) {}

  /** Hook identity and sequence are checked/allocated by the same SQLite writer. */
  async appendPluginHookEvent(ctx: LocalContext, input: {
    turnId: string; attemptId: string; expectedFencingToken: number;
    pluginGeneration: PluginGenerationIdentity; phase: "beforeTurn" | "afterTurn";
    eventType: string; payloadVersion?: number; data: unknown;
  }): Promise<TurnStreamEventModel> {
    return this.db.transaction(async tx => {
      await assertPluginGeneration(tx, input.pluginGeneration);
      const [deletion] = await tx.select({ id: deletionRequests.id }).from(deletionRequests).where(unverifiedDeletionRequest).limit(1);
      if (deletion) throw new Error("deletion_blocked");
      const [attempt] = await tx.select().from(turnAttempts).where(and(
        eq(turnAttempts.id, input.attemptId), eq(turnAttempts.turnId, input.turnId),
      ));
      if (!attempt || attempt.status !== "Running" || attempt.fencingToken !== input.expectedFencingToken) {
        throw new FencingMismatchError("plugin_hook_execution_expired");
      }
      const [last] = await tx.select({ sequence: turnStreamEvents.sequence }).from(turnStreamEvents)
        .where(eq(turnStreamEvents.turnId, input.turnId)).orderBy(desc(turnStreamEvents.sequence)).limit(1);
      const sequence = (last?.sequence ?? 0) + 1;
      const [created] = await tx.insert(turnStreamEvents).values({
        id: streamEventId(input.turnId, sequence), turnId: input.turnId, attemptId: input.attemptId,
        sequence, eventType: input.eventType, payloadVersion: input.payloadVersion ?? 1,
        data: input.data, occurredAt: new Date().toISOString(),
      }).returning();
      return created as TurnStreamEventModel;
    }, { behavior: "immediate" });
  }

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
      pluginGeneration?: PluginGenerationIdentity;
    },
  ): Promise<TurnStreamEventModel> {
    const fenced =
      eventData.attemptId != null && eventData.expectedFencingToken != null;
    // BEGIN IMMEDIATE：fencing 校验与插入在同一写锁内原子完成，
    // 杜绝「SELECT 校验通过 → 他方抢占提交 → 本事务再插入」的窗口（B1 CAS）。
    return this.db.transaction(
      async (tx) => {
        await assertPluginGeneration(tx, eventData.pluginGeneration);
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

  async isTurnStreamDisclosable(ctx: LocalContext, turnId: string): Promise<boolean> {
    const [row] = await this.db.select({ id: turns.id }).from(turns)
      .where(and(eq(turns.id, turnId), disclosableTurn(turnId))).limit(1);
    return row !== undefined;
  }

  async getStreamEventForDisclosure(
    ctx: LocalContext,
    turnId: string,
    eventId: string,
  ): Promise<TurnStreamEventModel | null> {
    // Fetch the durable payload and source visibility in one SQLite snapshot.
    // A transport page captured before deletion must never supply this payload.
    const [row] = await this.db.select().from(turnStreamEvents).where(and(
      eq(turnStreamEvents.turnId, turnId), eq(turnStreamEvents.id, eventId),
      disclosableTurn(turnId),
    )).limit(1);
    return (row as TurnStreamEventModel | undefined) ?? null;
  }

  async getStreamEventHighWater(ctx: LocalContext, turnId: string): Promise<number> {
    const [row] = await this.db.select({ sequence: turnStreamEvents.sequence })
      .from(turnStreamEvents).where(eq(turnStreamEvents.turnId, turnId))
      .orderBy(desc(turnStreamEvents.sequence)).limit(1);
    return row?.sequence ?? 0;
  }

  async getStreamReplayState(ctx: LocalContext, turnId: string): Promise<TurnStreamReplayState> {
    // Separate status/watermark reads can combine an old terminal Attempt with
    // a new continuation's empty stream, or miss a newly committed terminal event.
    // One SQLite statement gives both facts the same read snapshot. The scalar
    // high-water lookup uses the (turn_id, sequence) index without loading data.
    const [row] = await this.db.select({
      highWaterSequence: sql<number>`coalesce((select ${turnStreamEvents.sequence} from ${turnStreamEvents}
        where ${turnStreamEvents.turnId} = ${turnId} order by ${turnStreamEvents.sequence} desc limit 1), 0)`,
      settled: sql<number>`count(*) > 0 and count(case when ${turnAttempts.status}
        not in ('Completed', 'Failed', 'Interrupted', 'Cancelled') then 1 end) = 0`,
    }).from(turnAttempts).where(eq(turnAttempts.turnId, turnId));
    return { highWaterSequence: Number(row?.highWaterSequence ?? 0), settled: Number(row?.settled) === 1 };
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
