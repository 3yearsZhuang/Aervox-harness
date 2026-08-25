/**
 * Aervox｜思隅 @aervox/database — 安全事件 SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8（SafetyIncident）；访问受限，不写入普通记忆/分析明细。
 */
import { eq, and, desc } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { safetyIncidents } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type { ISafetyRepository, SafetyIncidentModel } from "../types.js";

export class SqliteSafetyRepository implements ISafetyRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async recordIncident(
    tenant: TenantContext,
    incidentData: { id: string; category: string; severity: string; disposition: string; policyVersion: string },
  ): Promise<SafetyIncidentModel> {
    assertTenantContext(tenant);
    const [created] = await this.db
      .insert(safetyIncidents)
      .values({
        id: incidentData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        category: incidentData.category,
        severity: incidentData.severity,
        disposition: incidentData.disposition,
        policyVersion: incidentData.policyVersion,
        createdAt: new Date().toISOString(),
      })
      .returning();
    return created as SafetyIncidentModel;
  }

  async listIncidents(tenant: TenantContext, limit: number = 50): Promise<SafetyIncidentModel[]> {
    assertTenantContext(tenant);
    const rows = await this.db
      .select()
      .from(safetyIncidents)
      .where(
        and(
          eq(safetyIncidents.workspaceId, tenant.workspaceId),
          eq(safetyIncidents.subjectUserId, tenant.subjectUserId),
        ),
      )
      .orderBy(desc(safetyIncidents.createdAt))
      .limit(limit);
    return rows as SafetyIncidentModel[];
  }
}
