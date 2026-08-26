/**
 * Aervox｜思隅 @aervox/database — 上下文压缩标记 SQLite 仓储（T-03）
 *
 * 幂等写入 + 快照溯源不可改写；memory_events 审计联动（action = "compressed"）。
 */
import { eq, and } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  memoryCompactionMarkers,
  memoryEvents,
} from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IMemoryCompactionRepository,
  MemoryCompactionMarkerModel,
} from "../types.js";

export class SqliteMemoryCompactionRepository implements IMemoryCompactionRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async upsertMarker(
    tenant: TenantContext,
    marker: {
      id: string;
      memoryId: string;
      snapshotId: string;
      coveredUpToMessageId?: string | null;
      summaryText?: string | null;
      phase?: string;
      status?: string;
      thoughtDurationMs?: number | null;
      summaryDurationMs?: number | null;
    },
  ): Promise<MemoryCompactionMarkerModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();

    // 幂等：同 memoryId + snapshotId 已存在则不覆盖（快照不可改写）
    const [existing] = await this.db
      .select()
      .from(memoryCompactionMarkers)
      .where(
        and(
          eq(memoryCompactionMarkers.memoryId, marker.memoryId),
          eq(memoryCompactionMarkers.snapshotId, marker.snapshotId),
          eq(memoryCompactionMarkers.workspaceId, tenant.workspaceId),
          eq(memoryCompactionMarkers.subjectUserId, tenant.subjectUserId),
        ),
      );
    if (existing) return existing as MemoryCompactionMarkerModel;

    const [created] = await this.db
      .insert(memoryCompactionMarkers)
      .values({
        id: marker.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        memoryId: marker.memoryId,
        snapshotId: marker.snapshotId,
        coveredUpToMessageId: marker.coveredUpToMessageId ?? null,
        summaryText: marker.summaryText ?? null,
        phase: marker.phase ?? "auto",
        status: marker.status ?? "completed",
        thoughtDurationMs: marker.thoughtDurationMs ?? null,
        summaryDurationMs: marker.summaryDurationMs ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as MemoryCompactionMarkerModel;
  }

  async getMarkerBySnapshotId(
    tenant: TenantContext,
    snapshotId: string,
  ): Promise<MemoryCompactionMarkerModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(memoryCompactionMarkers)
      .where(
        and(
          eq(memoryCompactionMarkers.snapshotId, snapshotId),
          eq(memoryCompactionMarkers.workspaceId, tenant.workspaceId),
          eq(memoryCompactionMarkers.subjectUserId, tenant.subjectUserId),
        ),
      )
      .limit(1);
    return (found as MemoryCompactionMarkerModel) ?? null;
  }

  async listMarkersByMemoryId(
    tenant: TenantContext,
    memoryId: string,
  ): Promise<MemoryCompactionMarkerModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(memoryCompactionMarkers)
      .where(
        and(
          eq(memoryCompactionMarkers.memoryId, memoryId),
          eq(memoryCompactionMarkers.workspaceId, tenant.workspaceId),
          eq(memoryCompactionMarkers.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(memoryCompactionMarkers.createdAt);
    return rows as MemoryCompactionMarkerModel[];
  }

  async recordEvent(
    tenant: TenantContext,
    event: {
      id: string;
      memoryId: string;
      action: string;
      fromTier?: string | null;
      toTier?: string | null;
      reason?: string | null;
      actorType?: string;
    },
  ): Promise<void> {
    assertTenantContext(tenant);
    await this.db.insert(memoryEvents).values({
      id: event.id,
      memoryId: event.memoryId,
      action: event.action,
      fromTier: event.fromTier ?? null,
      toTier: event.toTier ?? null,
      reason: event.reason ?? null,
      actorType: event.actorType ?? "system",
      createdAt: new Date().toISOString(),
    });
  }
}