/**
 * Aervox｜思隅 @aervox/database — 事务 Outbox SQLite 仓储实现
 *
 * 规则依据：ADR-004 + ADR-013
 */
import { eq, and, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { outboxEvents } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type { IOutboxRepository, OutboxEventModel } from "../types.js";

export class SqliteOutboxRepository implements IOutboxRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async insertEvent(
    tenant: TenantContext,
    eventData: {
      id: string;
      idempotencyKey: string;
      eventType: string;
      payload: unknown;
      controlEventId?: string | null;
    },
  ): Promise<OutboxEventModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(outboxEvents)
      .values({
        id: eventData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        controlEventId: eventData.controlEventId ?? null,
        idempotencyKey: eventData.idempotencyKey,
        eventType: eventData.eventType,
        payload: eventData.payload,
        status: "pending",
        retryCount: 0,
        createdAt: now,
      })
      .returning();
    return created as OutboxEventModel;
  }

  async fetchPendingEvents(limit: number = 50): Promise<OutboxEventModel[]> {
    const rows = await this.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.status, "pending"))
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

  async markFailed(eventId: string, error: string): Promise<void> {
    await this.db
      .update(outboxEvents)
      .set({
        status: "failed",
        retryCount: sql`${outboxEvents.retryCount} + 1`,
        lastError: error,
      })
      .where(eq(outboxEvents.id, eventId));
  }
}
