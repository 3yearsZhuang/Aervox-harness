/**
 * Aervox｜思隅 @aervox/repositories — safety 仓储类型（自 types.ts 机械拆分）
 */
import type { SafetyIncidentModel } from "./study-material.js";
import type { LocalContext } from "../../local-context.js";

export interface ISafetyRepository {
  recordIncident(
    tenant: LocalContext,
    incident: { id: string; category: string; severity: string; disposition: string; policyVersion: string },
  ): Promise<SafetyIncidentModel>;
  listIncidents(tenant: LocalContext, limit?: number): Promise<SafetyIncidentModel[]>;
}

export interface ConsentGrantModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  actorId: string;
  purpose: string;
  scope: string;
  policyVersion: string;
  grantedAt: string;
  revokedAt?: string | null;
  createdAt: string;
}

export interface DeletionRequestModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  scope: string;
  idempotencyKey: string;
  requestedAt: string;
  effectiveAt?: string | null;
  status: string;
  attemptCount: number;
  lastError?: string | null;
  ownerModule: string;
  lastVerifiedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeletionTargetModel {
  requestId: string;
  targetType: string;
  targetId: string;
  ownerModule: string;
  status: string;
  attemptCount: number;
  verifiedAt?: string | null;
  evidenceRef?: string | null;
}
