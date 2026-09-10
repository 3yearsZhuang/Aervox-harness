/**
 * Aervox｜思隅 @aervox/repositories — recovery-ledger 仓储类型（自 types.ts 机械拆分）
 */
import type { RecoveryLedgerEventModel } from "./privacy.js";

export interface IRecoveryLedgerPort {
  appendEvent(event: {
    eventId: string;
    idempotencyKey: string;
    eventType: string;
    workspaceRef?: string | null;
    subjectRef?: string | null;
    targetRef?: string | null;
    occurredAt?: string;
    tamperEvidence?: unknown;
  }): Promise<RecoveryLedgerEventModel>;
  getMaxSequence(): Promise<number>;
  getBySequence(sequence: number): Promise<RecoveryLedgerEventModel | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<RecoveryLedgerEventModel | null>;
}

export interface ExternalSourceModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  provider: string;
  externalId: string;
  permissionScope: string;
  syncState: string;
  revokedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PluginModel {
  id: string;
  publisher: string;
  version: string;
  checksum: string;
  signature?: string | null;
  permissions?: unknown;
  installSource: string;
  enabled: number;
  configSchemaJson?: unknown;
  configSchemaVersion?: number;
  createdAt: string;
  updatedAt: string;
}

export interface PluginGrantModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  pluginId: string;
  permission: string;
  scope: string;
  grantedAt: string;
  revokedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityContentModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  authorId: string;
  type: string;
  status: string;
  reviewState: string;
  visibility: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  ownerId: string;
  memberScope: string;
  policyVersion: string;
  createdAt: string;
  updatedAt: string;
}
