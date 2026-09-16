/**
 * Aervox｜思隅 @aervox/repositories — privacy 仓储类型（自 types.ts 机械拆分）
 */
import type { ConsentGrantModel, DeletionRequestModel, DeletionTargetModel } from "./safety.js";
import type { LocalContext } from "../../local-context.js";

export interface IPrivacyRepository {
  /** 2d：该租户是否存在未完成的删除/撤权请求（Loop fail-closed 闸门数据源） */
  hasPendingDeletionRequest(ctx: LocalContext): Promise<boolean>;
  grantConsent(
    ctx: LocalContext,
    grant: {
      id: string;
      actorId: string;
      purpose: string;
      scope: string;
      policyVersion: string;
      grantedAt?: string;
    },
  ): Promise<ConsentGrantModel>;
  revokeConsent(ctx: LocalContext, id: string, revokedAt?: string): Promise<ConsentGrantModel | null>;
  hasActiveConsent(ctx: LocalContext, purpose: string, scope: string): Promise<boolean>;
  createDeletionRequest(
    ctx: LocalContext,
    request: {
      id: string;
      scope: string;
      idempotencyKey: string;
      requestedAt?: string;
      ownerModule: string;
    },
  ): Promise<DeletionRequestModel>;
  getDeletionRequest(ctx: LocalContext, id: string): Promise<DeletionRequestModel | null>;
  updateDeletionRequestStatus(
    ctx: LocalContext,
    id: string,
    status: string,
    patch?: { lastError?: string | null; lastVerifiedAt?: string; attemptCount?: number },
  ): Promise<DeletionRequestModel | null>;
  createDeletionTarget(
    target: { requestId: string; targetType: string; targetId: string; ownerModule: string },
  ): Promise<DeletionTargetModel>;
  updateDeletionTargetStatus(
    target: { requestId: string; targetType: string; targetId: string },
    status: string,
    evidenceRef?: string,
  ): Promise<DeletionTargetModel | null>;
}

export interface RecoveryLedgerEventModel {
  eventId: string;
  idempotencyKey: string;
  eventType: string;
  workspaceRef?: string | null;
  subjectRef?: string | null;
  targetRef?: string | null;
  occurredAt: string;
  sequence: number;
  tamperEvidence?: unknown;
}
