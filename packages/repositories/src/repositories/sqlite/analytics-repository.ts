/**
 * Aervox｜思隅 @aervox/database — 埋点事件 SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8（AnalyticsEvent）
 */
import { eq, and, desc } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { analyticsEvents } from "@aervox/schema";
import type { LocalContext } from "../../local-context.js";
import type { IAnalyticsRepository, AnalyticsEventModel } from "../types/index.js";

export class SqliteAnalyticsRepository implements IAnalyticsRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async recordEvent(
    tenant: LocalContext,
    eventData: {
      id: string;
      eventName: string;
      eventSchemaVersion?: number;
      occurredAt?: string;
      analyticsSubjectId: string;
      context?: unknown;
      privacyClass?: string;
    },
  ): Promise<AnalyticsEventModel> {
    const [created] = await this.db
      .insert(analyticsEvents)
      .values({
        id: eventData.id,
        eventName: eventData.eventName,
        eventSchemaVersion: eventData.eventSchemaVersion ?? 1,
        occurredAt: eventData.occurredAt ?? new Date().toISOString(),
        analyticsSubjectId: eventData.analyticsSubjectId,
        context: eventData.context ?? null,
        privacyClass: eventData.privacyClass ?? "normal",
      })
      .returning();
    return created as AnalyticsEventModel;
  }

  async listEventsBySubject(
    tenant: LocalContext,
    analyticsSubjectId: string,
    limit: number = 100,
  ): Promise<AnalyticsEventModel[]> {
    const rows = await this.db
      .select()
      .from(analyticsEvents)
      .where(
        and(
          eq(analyticsEvents.analyticsSubjectId, analyticsSubjectId),
        ),
      )
      .orderBy(desc(analyticsEvents.occurredAt))
      .limit(limit);
    return rows as AnalyticsEventModel[];
  }
}
