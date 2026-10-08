/**
 * Aervox｜思隅 @aervox/repositories — 隐私/删除域 SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8（ConsentGrant/DeletionRequest/DeletionTarget）
 */
import { eq, and, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import { consentGrants, deletionRequests, deletionTargets } from "@aervox/schema";
import type { LocalContext } from "../../local-context.js";
import type {
  IPrivacyRepository,
  ConsentGrantModel,
  DeletionRequestModel,
  DeletionTargetModel,
} from "../types/index.js";

/** Shared retry/gate predicate: legacy completion without supported verification stays denied. */
export const unverifiedDeletionRequest = sql`${deletionRequests.status} != 'completed' OR ${deletionRequests.lastVerifiedAt} IS NULL
            OR NOT EXISTS (SELECT 1 FROM deletion_targets t WHERE t.request_id = ${deletionRequests.id})
            OR EXISTS (SELECT 1 FROM deletion_targets t WHERE t.request_id = ${deletionRequests.id}
              AND (t.status != 'completed' OR t.verified_at IS NULL OR
                CASE WHEN json_valid(t.evidence_ref) THEN json_extract(t.evidence_ref, '$.verifier') ELSE NULL END IS NOT 'memory-local-v1'))`;

export class SqlitePrivacyRepository implements IPrivacyRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async grantConsent(
    ctx: LocalContext,
    grantData: {
      id: string;
      actorId: string;
      purpose: string;
      scope: string;
      policyVersion: string;
      grantedAt?: string;
    },
  ): Promise<ConsentGrantModel> {
    const [created] = await this.db
      .insert(consentGrants)
      .values({
        id: grantData.id,
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

  async revokeConsent(ctx: LocalContext, id: string, revokedAt?: string): Promise<ConsentGrantModel | null> {
    const [updated] = await this.db
      .update(consentGrants)
      .set({ revokedAt: revokedAt ?? new Date().toISOString() })
      .where(
        and(
          eq(consentGrants.id, id),
        ),
      )
      .returning();
    return (updated as ConsentGrantModel) ?? null;
  }

  async hasActiveConsent(ctx: LocalContext, purpose: string, scope: string): Promise<boolean> {
    const [found] = await this.db
      .select()
      .from(consentGrants)
      .where(
        and(
          eq(consentGrants.purpose, purpose),
          eq(consentGrants.scope, scope),
          sql`${consentGrants.revokedAt} IS NULL`,
        ),
      );
    return !!found;
  }

  /** 2d：该租户是否存在未完成的删除/撤权请求（删除/撤权水位未追平；AVX-HAR-001 §11.3 fail-closed 闸门数据源） */
  async hasPendingDeletionRequest(ctx: LocalContext): Promise<boolean> {
    const rows = await this.db
      .select({ id: deletionRequests.id })
      .from(deletionRequests)
      .where(
        and(
          unverifiedDeletionRequest,
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async createDeletionRequest(
    ctx: LocalContext,
    requestData: {
      id: string;
      scope: string;
      idempotencyKey: string;
      requestedAt?: string;
      ownerModule: string;
      targets?: Array<{ targetType: string; targetId: string; ownerModule: string }>;
    },
  ): Promise<DeletionRequestModel> {
    return this.db.transaction(async (tx) => {
      const [existing] = await tx.select().from(deletionRequests).where(eq(deletionRequests.idempotencyKey, requestData.idempotencyKey));
      if (existing) return existing as DeletionRequestModel;
      const now = new Date().toISOString();
      const [created] = await tx.insert(deletionRequests).values({
        id: requestData.id, scope: requestData.scope, idempotencyKey: requestData.idempotencyKey,
        requestedAt: requestData.requestedAt ?? now, status: "pending", attemptCount: 0,
        ownerModule: requestData.ownerModule, createdAt: now, updatedAt: now,
      }).returning();
      for (const target of requestData.targets ?? []) {
        await tx.insert(deletionTargets).values({ ...target, requestId: requestData.id, status: "pending", attemptCount: 0 });
      }
      return created as DeletionRequestModel;
    });
  }

  async getDeletionRequest(ctx: LocalContext, id: string): Promise<DeletionRequestModel | null> {
    const [found] = await this.db
      .select()
      .from(deletionRequests)
      .where(
        and(
          eq(deletionRequests.id, id),
        ),
      );
    return (found as DeletionRequestModel) ?? null;
  }

  async updateDeletionRequestStatus(
    ctx: LocalContext,
    id: string,
    status: string,
    patch?: { lastError?: string | null; lastVerifiedAt?: string; attemptCount?: number },
  ): Promise<DeletionRequestModel | null> {
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
    if (status !== "completed") {
      updateData.verifiedAt = null;
      updateData.evidenceRef = null;
    }
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
