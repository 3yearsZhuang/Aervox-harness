/**
 * Aervox｜思隅 @aervox/repositories — 主动画像审计事件与隐私同意查询 Store
 */
import { and, desc, eq } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import { consentGrants, proactiveAuditEvents } from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import type {
  IProactiveProfileRepository,
  ProactiveAuditEventModel,
  ProactiveConsentModel,
} from "../../types/index.js";
import { clampLimit, localBoundary, MAX_LIST_LIMIT, parseJson, stringify } from "./shared.js";

type AuditRow = typeof proactiveAuditEvents.$inferSelect;

function toAudit(row: AuditRow): ProactiveAuditEventModel {
  return {
    id: row.id,
    revisionId: row.revisionId,
    eventType: row.eventType,
    actorId: row.actorId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    payload: parseJson(row.payloadJson, {}),
    processingBoundary: localBoundary(row.processingBoundary),
    occurredAt: row.occurredAt,
    createdAt: row.createdAt,
  };
}

export class AuditExportStore {
  constructor(private readonly db: AervoxDatabase) {}

  async recordAudit(
    ctx: LocalContext,
    input: Parameters<IProactiveProfileRepository["recordAudit"]>[1],
  ): Promise<ProactiveAuditEventModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(proactiveAuditEvents)
      .values({
        id: input.id,
        revisionId: input.revisionId ?? null,
        eventType: input.eventType,
        actorId: input.actorId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        payloadJson: stringify(input.payload),
        processingBoundary: "local_only",
        occurredAt: now,
        createdAt: now,
      })
      .returning();
    if (!created) throw new Error("failed to record proactive audit event");
    return toAudit(created);
  }

  async listAuditEvents(ctx: LocalContext, limit?: number): Promise<ProactiveAuditEventModel[]> {
    const rows = await this.db
      .select()
      .from(proactiveAuditEvents)
      .where(
        and(
        ),
      )
      .orderBy(desc(proactiveAuditEvents.occurredAt))
      .limit(clampLimit(limit));
    return rows.map(toAudit);
  }

  async listProactiveConsents(ctx: LocalContext): Promise<ProactiveConsentModel[]> {
    const rows = await this.db
      .select()
      .from(consentGrants)
      .where(
        and(
          eq(consentGrants.purpose, "proactive_profile"),
        ),
      )
      .orderBy(desc(consentGrants.grantedAt))
      .limit(MAX_LIST_LIMIT);
    return rows.map((row) => ({
      id: row.id,
      actorId: row.actorId,
      purpose: row.purpose,
      scope: row.scope,
      policyVersion: row.policyVersion,
      grantedAt: row.grantedAt,
      revokedAt: row.revokedAt,
      createdAt: row.createdAt,
    }));
  }
}
