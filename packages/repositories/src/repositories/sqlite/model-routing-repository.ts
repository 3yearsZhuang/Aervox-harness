/**
 * Aervox｜思隅 @aervox/repositories — 本地模型降级阶梯与健康探测 SQLite 仓储实现 (CR-034/CR-042)
 *
 * 规则依据：CR-034（已归档至归档库）
 * - 管理预设级健康快照（探测状态、连续成功/失败计数、迟滞与冷却时间）；
 * - 记录切层审计事件账本（可追溯层级切换、回切与降级原因）。
 */
import { desc, eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { llmHealthSnapshots, llmRoutingEvents } from "@aervox/schema";
import type {
  HealthSnapshot,
  ModelRoutingEvent,
  HealthStatus,
  ProbeErrorCategory,
  ModelRoutingTier,
  LLMProviderType,
} from "@aervox/contracts";

function rowToHealthSnapshot(row: typeof llmHealthSnapshots.$inferSelect): HealthSnapshot {
  return {
    presetId: row.presetId,
    providerType: row.providerType as LLMProviderType,
    endpointIdentity: row.endpointIdentity,
    status: row.status as HealthStatus,
    consecutiveSuccesses: row.consecutiveSuccesses,
    consecutiveFailures: row.consecutiveFailures,
    latencyMs: row.latencyMs ?? null,
    lastProbeAt: row.lastProbeAt ?? null,
    lastSuccessAt: row.lastSuccessAt ?? null,
    lastFailureAt: row.lastFailureAt ?? null,
    errorCategory: (row.errorCategory as ProbeErrorCategory) ?? null,
    errorMessage: row.errorMessage ?? null,
    cooldownUntil: row.cooldownUntil ?? null,
  };
}

function rowToRoutingEvent(row: typeof llmRoutingEvents.$inferSelect): ModelRoutingEvent {
  return {
    id: row.id,
    sessionId: row.sessionId ?? null,
    turnId: row.turnId ?? null,
    fromTier: row.fromTier as ModelRoutingTier,
    toTier: row.toTier as ModelRoutingTier,
    fromPresetId: row.fromPresetId ?? null,
    toPresetId: row.toPresetId ?? null,
    reason: row.reason,
    occurredAt: row.occurredAt,
  };
}

export class SqliteModelRoutingRepository {
  constructor(private readonly db: AervoxDatabase) {}

  /** 保存或更新预设级健康探测快照（按 presetId 幂等 upsert） */
  async saveHealthSnapshot(snapshot: HealthSnapshot): Promise<void> {
    const now = new Date().toISOString();
    const existing = await this.db
      .select()
      .from(llmHealthSnapshots)
      .where(eq(llmHealthSnapshots.presetId, snapshot.presetId))
      .limit(1);

    if (existing.length > 0) {
      await this.db
        .update(llmHealthSnapshots)
        .set({
          providerType: snapshot.providerType,
          endpointIdentity: snapshot.endpointIdentity,
          status: snapshot.status,
          consecutiveSuccesses: snapshot.consecutiveSuccesses,
          consecutiveFailures: snapshot.consecutiveFailures,
          latencyMs: snapshot.latencyMs,
          lastProbeAt: snapshot.lastProbeAt,
          lastSuccessAt: snapshot.lastSuccessAt,
          lastFailureAt: snapshot.lastFailureAt,
          errorCategory: snapshot.errorCategory,
          errorMessage: snapshot.errorMessage,
          cooldownUntil: snapshot.cooldownUntil,
          updatedAt: now,
        })
        .where(eq(llmHealthSnapshots.presetId, snapshot.presetId));
    } else {
      await this.db.insert(llmHealthSnapshots).values({
        presetId: snapshot.presetId,
        providerType: snapshot.providerType,
        endpointIdentity: snapshot.endpointIdentity,
        status: snapshot.status,
        consecutiveSuccesses: snapshot.consecutiveSuccesses,
        consecutiveFailures: snapshot.consecutiveFailures,
        latencyMs: snapshot.latencyMs,
        lastProbeAt: snapshot.lastProbeAt,
        lastSuccessAt: snapshot.lastSuccessAt,
        lastFailureAt: snapshot.lastFailureAt,
        errorCategory: snapshot.errorCategory,
        errorMessage: snapshot.errorMessage,
        cooldownUntil: snapshot.cooldownUntil,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  /** 获取指定预设的健康探测快照 */
  async getHealthSnapshot(presetId: string): Promise<HealthSnapshot | null> {
    const rows = await this.db
      .select()
      .from(llmHealthSnapshots)
      .where(eq(llmHealthSnapshots.presetId, presetId))
      .limit(1);

    if (rows.length === 0) return null;
    return rowToHealthSnapshot(rows[0]!);
  }

  /** 列出所有预设的健康探测快照 */
  async listHealthSnapshots(): Promise<HealthSnapshot[]> {
    const rows = await this.db
      .select()
      .from(llmHealthSnapshots);

    return rows.map(rowToHealthSnapshot);
  }

  /** 记录切层与回切审计事件（追加式，不可篡改） */
  async recordRoutingEvent(event: ModelRoutingEvent): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insert(llmRoutingEvents).values({
      id: event.id,
      sessionId: event.sessionId,
      turnId: event.turnId,
      fromTier: event.fromTier,
      toTier: event.toTier,
      fromPresetId: event.fromPresetId,
      toPresetId: event.toPresetId,
      reason: event.reason,
      occurredAt: event.occurredAt,
      createdAt: now,
    });
  }

  /** 查询切层审计历史 */
  async listRoutingEvents(limit = 50): Promise<ModelRoutingEvent[]> {
    const rows = await this.db
      .select()
      .from(llmRoutingEvents)
      .orderBy(desc(llmRoutingEvents.occurredAt))
      .limit(limit);

    return rows.map(rowToRoutingEvent);
  }

  /** 查询指定会话的切层审计历史 */
  async listRoutingEventsForSession(sessionId: string, limit = 50): Promise<ModelRoutingEvent[]> {
    const rows = await this.db
      .select()
      .from(llmRoutingEvents)
      .where(eq(llmRoutingEvents.sessionId, sessionId))
      .orderBy(desc(llmRoutingEvents.occurredAt))
      .limit(limit);

    return rows.map(rowToRoutingEvent);
  }
}
