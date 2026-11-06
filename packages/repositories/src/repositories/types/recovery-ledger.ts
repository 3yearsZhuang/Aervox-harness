/**
 * Aervox｜思隅 @aervox/repositories — recovery-ledger 仓储类型（自 types.ts 机械拆分）
 */
import type { RecoveryLedgerEventModel } from "./privacy.js";

export interface IRecoveryLedgerPort {
  /** A new event requires a valid contiguous sequence history and space for the next safe integer. */
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
  /** Empty returns 0; any invalid persisted sequence rejects instead of hiding behind MAX. */
  getMaxSequence(): Promise<number>;
  /** Positive safe-integer lookup only; multiple events at a sequence reject as ambiguous. */
  getBySequence(sequence: number): Promise<RecoveryLedgerEventModel | null>;
  /** Returned receipts (including retries) require a positive safe-integer sequence. */
  getByIdempotencyKey(idempotencyKey: string): Promise<RecoveryLedgerEventModel | null>;
  /**
   * 只读一致性检查：重复序列 / 序列缺口 / 总量（缺口或重复即账本不可信）。
   * 无效序列或超过实现的行数/诊断预算时冲突拒绝，不返回截断的成功报告。
   */
  inspectConsistency(): Promise<{
    eventCount: number;
    maxSequence: number;
    duplicatedSequences: number[];
    missingSequences: number[];
  }>;
}

export interface ExternalSourceModel {
  id: string;
  provider: string;
  externalId: string;
  permissionScope: string;
  syncState: string;
  revokedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PluginModel {
  /** Changes irreversibly on activation changes or replacement; never derive this from wall-clock time. */
  lifecycleGeneration: string;
  bundleGeneration?: string | null;
  /** CR-056: missing/invalid/unreadable code blocks execution without changing enabled. */
  availability?: string;
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
  /** 插件主动智能声明（CR-032；manifest spec.proactive 解析结果） */
  proactiveSpecJson?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PluginGrantModel {
  id: string;
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
  ownerId: string;
  memberScope: string;
  policyVersion: string;
  createdAt: string;
  updatedAt: string;
}
