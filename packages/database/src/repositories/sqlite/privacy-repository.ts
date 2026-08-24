/**
 * Aervox｜思隅 @aervox/database — 隐私/删除域 SQLite 仓储实现
 *
 * 规则依据：docs/PRD.md §8（ConsentGrant/DeletionRequest/DeletionTarget）
 */
import { eq, and, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { consentGrants, deletionRequests, deletionTargets } from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";
import type {
  IPrivacyRepository,
  ConsentGrantModel,
  DeletionRequestModel,
  DeletionTargetModel,
} from "../types.js";

export class SqlitePrivacyRepository implements IPrivacyRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async grantConsent(
    tenant: TenantContext,
    grantData: {
      id: string;
      actorId: string;
      purpose: string;
      scope: string;
      policyVersion: string;
      grantedAt?: string;
    },
  ): Promise<ConsentGrantModel> {
    assertTenantContext(tenant);
    const [created] = await this.db
      .insert(consentGrants)
      .values({
        id: grantData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        actorId: grantData.actorId,
        purpose: grantData.purpose,
        scope: grantData.scope,
        policyVersion: grantData.policyVersion,
        grantedAt: grantData.grantedAt ?? new Date().toISOString(),
        createdAt: new Date().toISOString(),
      })
      .returning();
    return created as ConsentGrantModel;
  }

  async revokeConsent(tenant: TenantContext, id: string, revokedAt?: string): Promise<ConsentGrantModel | null> {
    assertTenantContext(tenant);
    const [updated] = await this.db
      .update(consentGrants)
      .set({ revokedAt: revokedAt ?? new Date().toISOString() })
      .where(
        and(
          eq(consentGrants.id, id),
          eq(consentGrants.workspaceId, tenant.workspaceId),
          eq(consentGrants.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return (updated as ConsentGrantModel) ?? null;
  }

  async hasActiveConsent(tenant: TenantContext, purpose: string, scope: string): Promise<boolean> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(consentGrants)
      .where(
        and(
          eq(consentGrants.workspaceId, tenant.workspaceId),
          eq(consentGrants.subjectUserId, tenant.subjectUserId),
          eq(consentGrants.purpose, purpose),
          eq(consentGrants.scope, scope),
          sql`${consentGrants.revokedAt} IS NULL`,
        ),
      );
    return !!found;
  }

  async createDeletionRequest(
    tenant: TenantContext,
    requestData: {
      id: string;
      scope: string;
      idempotencyKey: string;
      requestedAt?: string;
      ownerModule: string;
    },
  ): Promise<DeletionRequestModel> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(deletionRequests)
      .values({
        id: requestData.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        scope: requestData.scope,
        idempotencyKey: requestData.idempotencyKey,
        requestedAt: requestData.requestedAt ?? now,
        status: "pending",
        attemptCount: 0,
        ownerModule: requestData.ownerModule,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as DeletionRequestModel;
  }

  async getDeletionRequest(tenant: TenantContext, id: string): Promise<DeletionRequestModel | null> {
    assertTenantContext(tenant);
    const [found] = await this.db
      .select()
      .from(deletionRequests)
      .where(
        and(
          eq(deletionRequests.id, id),
          eq(deletionRequests.workspaceId, tenant.workspaceId),
          eq(deletionRequests.subjectUserId, tenant.subjectUserId),
        ),
      );
    return (found as DeletionRequestModel) ?? null;
  }

  async updateDeletionRequestStatus(
    tenant: TenantContext,
    id: string,
    status: string,
    patch?: { lastError?: string | null; lastVerifiedAt?: string; attemptCount?: number },
  ): Promise<DeletionRequestModel | null> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = { status, updatedAt: now };
    if (patch?.lastError !== undefined) updateData.lastError = patch.lastError;
    if (patch?.lastVerifiedAt !== undefined) updateData.lastVerifiedAt = patch.lastVerifiedAt;
    if (patch?.attemptCount !== undefined) updateData.attemptCount = patch.attemptCount;
    const [updated] = await this.db
      .update(deletionRequests)
      .set(updateData)
      .where(
        and(
          eq(deletionRequests.id, id),
          eq(deletionRequests.workspaceId, tenant.workspaceId),
          eq(deletionRequests.subjectUserId, tenant.subjectUserId),
        ),
      )
      .returning();
    return (updated as DeletionRequestModel) ?? null;
  }

  async createDeletionTarget(
    targetData: { requestId: string; targetType: string; targetId: string; ownerModule: string },
  ): Promise<DeletionTargetModel> {
    const [created] = await this.db
      .insert(deletionTargets)
      .values({
        requestId: targetData.requestId,
        targetType: targetData.targetType,
        targetId: targetData.targetId,
        ownerModule: targetData.ownerModule,
        status: "pending",
        attemptCount: 0,
      })
      .returning();
    return created as DeletionTargetModel;
  }

  async updateDeletionTargetStatus(
    target: { requestId: string; targetType: string; targetId: string },
    status: string,
    evidenceRef?: string,
  ): Promise<DeletionTargetModel | null> {
    const updateData: Record<string, unknown> = { status };
    if (status === "completed") {
      updateData.verifiedAt = new Date().toISOString();
    }
    if (evidenceRef !== undefined) updateData.evidenceRef = evidenceRef;
    const [updated] = await this.db
      .update(deletionTargets)
      .set(updateData)
      .where(
        and(
          eq(deletionTargets.requestId, target.requestId),
          eq(deletionTargets.targetType, target.targetType),
          eq(deletionTargets.targetId, target.targetId),
        ),
      )
      .returning();
    return (updated as DeletionTargetModel) ?? null;
  }
}
