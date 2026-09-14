/**
 * CR-033 E3 本地感知事件流 Port。
 *
 * 规则依据：docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
 * - SQLite 追加式事件流作为跨进程真源：原子 sequence、唯一幂等键、consumer offset、
 *   ACK、重放、过期 cursor、DLQ、保留与压缩策略；
 * - ingest 前校验 envelope 契约（schema version / local_only / payload digest），
 *   source grant 与 activation lease 校验由调用方（授权闸）负责；
 * - 事件流不进入普通远程数据面（local_only 强制）。
 */
import { createHash } from "node:crypto";
import { and, asc, eq, gt, lte, min, or, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { perceptionEvents, perceptionEventConsumers } from "@aervox/schema";
import type { PerceptionEventEnvelope } from "@aervox/contracts";
import type { LocalContext } from "../../local-context.js";

export interface IngestOutcome {
  ingested: boolean;
  /** 幂等命中时返回已存在事件 */
  duplicate: boolean;
  sequence: number | null;
  reason?: string;
}

export interface PerceptionEventRow {
  id: string;
  sequence: number;
  eventId: string;
  idempotencyKey: string;
  source: string;
  deviceId: string;
  activationEpoch: string;
  sourceGrantId: string;
  occurredAt: string;
  ingestedAt: string;
  schemaVersion: string;
  payloadDigest: string;
  payload: unknown;
  causal: unknown;
  status: string;
}

export function perceptionPayloadDigest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");
}

export class SqlitePerceptionEventRepository {
  constructor(private readonly db: AervoxDatabase) {}

  /**
   * 摄入事件：envelope 契约校验（digest 一致 + local_only）→ 幂等去重 → 原子 sequence 分配。
   * 校验失败 fail-closed 拒绝（不落库）；幂等命中返回 duplicate。
   */
  async ingest(_tenant: LocalContext, envelope: PerceptionEventEnvelope): Promise<IngestOutcome> {
    // fail-closed 校验：schema version 与 local_only 语义
    if (envelope.schemaVersion !== "perception_event_v1") {
      return { ingested: false, duplicate: false, sequence: null, reason: `unsupported schema version: ${envelope.schemaVersion}` };
    }
    // payload digest 一致性校验
    const actualDigest = perceptionPayloadDigest(envelope.payload);
    if (actualDigest !== envelope.payloadDigest) {
      return { ingested: false, duplicate: false, sequence: null, reason: "payload digest mismatch" };
    }

    // 幂等去重
    const [existing] = await this.db
      .select()
      .from(perceptionEvents)
      .where(eq(perceptionEvents.idempotencyKey, envelope.idempotencyKey))
      .limit(1);
    if (existing) {
      return { ingested: false, duplicate: true, sequence: existing.sequence, reason: "idempotency key already ingested" };
    }

    // sequence 在 INSERT 单条语句内分配；SQLite 对写语句串行化，避免 SELECT/INSERT 间竞态。
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(perceptionEvents)
      .values({
        id: envelope.eventId,
        sequence: sql<number>`(SELECT COALESCE(MAX(sequence), 0) + 1 FROM perception_events)`,
        eventId: envelope.eventId,
        idempotencyKey: envelope.idempotencyKey,
        source: envelope.source,
        deviceId: envelope.deviceId,
        activationEpoch: envelope.activationEpoch,
        sourceGrantId: envelope.sourceGrantId,
        occurredAt: envelope.occurredAt,
        ingestedAt: envelope.ingestedAt,
        schemaVersion: envelope.schemaVersion,
        payloadDigest: envelope.payloadDigest,
        payloadJson: JSON.stringify(envelope.payload ?? null),
        causalJson: envelope.causal ? JSON.stringify(envelope.causal) : null,
        status: "ready",
        localOnly: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    if (created) return { ingested: true, duplicate: false, sequence: created.sequence };

    // 并发幂等兜底：主键或幂等唯一索引冲突后重读。
    const [reread] = await this.db
      .select()
      .from(perceptionEvents)
      .where(or(
        eq(perceptionEvents.id, envelope.eventId),
        eq(perceptionEvents.idempotencyKey, envelope.idempotencyKey),
      ))
      .limit(1);
    if (!reread) {
      return {
        ingested: false,
        duplicate: false,
        sequence: null,
        reason: "event insert conflict without matching identity",
      };
    }
    return { ingested: false, duplicate: true, sequence: reread.sequence, reason: "concurrent duplicate" };
  }

  /** 读取或创建消费者游标（offset=0）。 */
  async ensureConsumer(_tenant: LocalContext, consumerId: string): Promise<{lastAckedSequence: number; expired: boolean}> {
    const [existing] = await this.db
      .select()
      .from(perceptionEventConsumers)
      .where(eq(perceptionEventConsumers.id, consumerId))
      .limit(1);
    if (existing) return { lastAckedSequence: existing.lastAckedSequence, expired: existing.expired };
    const now = new Date().toISOString();
    await this.db
      .insert(perceptionEventConsumers)
      .values({ id: consumerId, lastAckedSequence: 0, cursorUpdatedAt: now, expired: false, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
    return { lastAckedSequence: 0, expired: false };
  }

  /** 消费一批 ready 事件（offset 之后；过期 consumer fail-closed 拒绝）。 */
  async consume(
    tenant: LocalContext,
    consumerId: string,
    batchSize = 64,
  ): Promise<Array<PerceptionEventRow>> {
    const cursor = await this.ensureConsumer(tenant, consumerId);
    if (cursor.expired) return []; // fail-closed：过期 cursor 必须先重置
    const rows = await this.db
      .select()
      .from(perceptionEvents)
      .where(and(
        eq(perceptionEvents.status, "ready"),
        gt(perceptionEvents.sequence, cursor.lastAckedSequence),
      ))
      .orderBy(asc(perceptionEvents.sequence))
      .limit(batchSize);
    return rows.map((row) => this.toRow(row));
  }

  /** ACK：单调推进 offset（不允许回退）；游标不存在时以该 sequence 建立起点。 */
  async ack(_tenant: LocalContext, consumerId: string, sequence: number): Promise<void> {
    const [maxRow] = await this.db
      .select({ maxSeq: sql<number>`COALESCE(MAX(${perceptionEvents.sequence}), 0)` })
      .from(perceptionEvents);
    const maxSequence = maxRow?.maxSeq ?? 0;
    if (!Number.isInteger(sequence) || sequence < 0 || sequence > maxSequence) {
      throw new Error(`invalid perception ACK ${sequence}; current max sequence is ${maxSequence}`);
    }
    const now = new Date().toISOString();
    await this.db
      .insert(perceptionEventConsumers)
      .values({
        id: consumerId,
        lastAckedSequence: sequence,
        cursorUpdatedAt: now,
        expired: false,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    await this.db
      .update(perceptionEventConsumers)
      .set({
        lastAckedSequence: sql`MAX(${perceptionEventConsumers.lastAckedSequence}, ${sequence})`,
        cursorUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(perceptionEventConsumers.id, consumerId));
  }

  /** 重放：从指定 sequence 起读取（不改 offset）。 */
  async replay(_tenant: LocalContext, fromSequence: number, limit = 256): Promise<Array<PerceptionEventRow>> {
    const rows = await this.db
      .select()
      .from(perceptionEvents)
      .where(and(
        eq(perceptionEvents.status, "ready"),
        gt(perceptionEvents.sequence, fromSequence - 1),
      ))
      .orderBy(asc(perceptionEvents.sequence))
      .limit(limit);
    return rows.map((row) => this.toRow(row));
  }

  /** 处理失败进死信（保留待人工 reconciliation；未知结果不得自动重放）。 */
  async markDead(_tenant: LocalContext, eventId: string): Promise<boolean> {
    const updated = await this.db
      .update(perceptionEvents)
      .set({ status: "dead", updatedAt: new Date().toISOString() })
      .where(eq(perceptionEvents.id, eventId))
      .returning({ id: perceptionEvents.id });
    return updated.length > 0;
  }

  /** 过期游标标记（cursor 长时间未推进的 consumer 需重置后才能继续消费）。 */
  async expireStaleConsumers(_tenant: LocalContext, staleBefore: Date): Promise<number> {
    const updated = await this.db
      .update(perceptionEventConsumers)
      .set({ expired: true, updatedAt: new Date().toISOString() })
      .where(and(
        eq(perceptionEventConsumers.expired, false),
        lte(perceptionEventConsumers.cursorUpdatedAt, staleBefore.toISOString()),
      ))
      .returning({ id: perceptionEventConsumers.id });
    return updated.length;
  }

  /** 重置过期 consumer（重建后从当前最大 sequence 继续，不重放历史）。 */
  async resetExpiredConsumer(_tenant: LocalContext, consumerId: string): Promise<boolean> {
    const [maxRow] = await this.db
      .select({ maxSeq: sql<number>`COALESCE(MAX(${perceptionEvents.sequence}), 0)` })
      .from(perceptionEvents);
    const now = new Date().toISOString();
    const updated = await this.db
      .update(perceptionEventConsumers)
      .set({
        lastAckedSequence: maxRow?.maxSeq ?? 0,
        expired: false,
        cursorUpdatedAt: now,
        updatedAt: now,
      })
      .where(and(eq(perceptionEventConsumers.id, consumerId), eq(perceptionEventConsumers.expired, true)))
      .returning({ id: perceptionEventConsumers.id });
    return updated.length > 0;
  }

  /** 保留/压缩：仅删除所有活跃消费者均已 ACK 的历史事件。 */
  async purgeBeforeSequence(_tenant: LocalContext, sequence: number): Promise<number> {
    const [cursor] = await this.db
      .select({ minAck: min(perceptionEventConsumers.lastAckedSequence) })
      .from(perceptionEventConsumers)
      .where(eq(perceptionEventConsumers.expired, false));
    if (cursor?.minAck === null || cursor?.minAck === undefined) return 0;
    const safeSequence = Math.min(sequence, cursor.minAck);
    if (safeSequence <= 0) return 0;
    const deleted = await this.db
      .delete(perceptionEvents)
      .where(lte(perceptionEvents.sequence, safeSequence))
      .returning({ id: perceptionEvents.id });
    return deleted.length;
  }

  private toRow(row: typeof perceptionEvents.$inferSelect): PerceptionEventRow {
    return {
      id: row.id,
      sequence: row.sequence,
      eventId: row.eventId,
      idempotencyKey: row.idempotencyKey,
      source: row.source,
      deviceId: row.deviceId,
      activationEpoch: row.activationEpoch,
      sourceGrantId: row.sourceGrantId,
      occurredAt: row.occurredAt,
      ingestedAt: row.ingestedAt,
      schemaVersion: row.schemaVersion,
      payloadDigest: row.payloadDigest,
      payload: JSON.parse(row.payloadJson),
      causal: row.causalJson ? JSON.parse(row.causalJson) : null,
      status: row.status,
    };
  }
}
