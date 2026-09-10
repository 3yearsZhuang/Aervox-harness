/**
 * Aervox｜思隅 @aervox/repositories — platform 仓储类型（自 types.ts 机械拆分）
 */
import type { AuditRecordModel, ContextManifestModel, ModelRunModel, NotificationModel, PromptVersionModel, ScheduledJobModel } from "./provenance.js";
import type { LocalContext } from "../../local-context.js";

export interface IPlatformRepository {
  createScheduledJob(
    tenant: LocalContext,
    job: { id: string; jobType: string; subjectId: string; idempotencyKey: string; runAt: string },
  ): Promise<ScheduledJobModel>;
  markJobDone(tenant: LocalContext, id: string): Promise<ScheduledJobModel | null>;
  createNotification(
    tenant: LocalContext,
    notification: { id: string; type: string; scheduledAt: string; channel: string },
  ): Promise<NotificationModel>;
  markNotificationSent(tenant: LocalContext, id: string): Promise<NotificationModel | null>;
  listNotifications(tenant: LocalContext, limit?: number): Promise<NotificationModel[]>;
  createPromptVersion(
    version: { id: string; purpose: string; version: number; checksum: string; status?: string },
  ): Promise<PromptVersionModel>;
  getPromptVersion(purpose: string, version: number): Promise<PromptVersionModel | null>;
  createModelRun(
    tenant: LocalContext,
    run: {
      id: string;
      purpose: string;
      provider: string;
      modelId: string;
      promptVersionId?: string | null;
    },
  ): Promise<ModelRunModel>;
  completeModelRun(
    tenant: LocalContext,
    id: string,
    result: { latencyMs?: number; tokenUsage?: unknown; cost?: number; status?: string },
  ): Promise<ModelRunModel | null>;
  attachContextManifest(tenant: LocalContext, modelRunId: string, manifestId: string): Promise<ModelRunModel | null>;
  createContextManifest(
    manifest: {
      id: string;
      modelRunId: string;
      purpose: string;
      sourceArtifactId: string;
      sourceRevisionId: string;
      selectionReason?: string | null;
      permissionSnapshot?: unknown;
      tokenBudget?: number | null;
    },
  ): Promise<ContextManifestModel>;
  createAuditRecord(
    tenant: LocalContext,
    record: {
      id: string;
      actorType: string;
      actorId: string;
      action: string;
      subjectType: string;
      subjectId: string;
      metadata?: unknown;
    },
  ): Promise<AuditRecordModel>;
  listAuditRecords(tenant: LocalContext, limit?: number): Promise<AuditRecordModel[]>;
  // MVP 补齐（PRD §8）：工具策略 + 评估集（系统级，无租户列）
  createToolPolicy(policy: {
    id: string;
    purpose: string;
    toolName: string;
    scope?: string;
    approvalMode?: string;
    timeoutMs?: number | null;
    quota?: number | null;
    version?: number;
    status?: string;
  }): Promise<ToolPolicyModel>;
  getToolPolicy(purpose: string, toolName: string, version: number): Promise<ToolPolicyModel | null>;
  createEvalSet(evalSet: {
    id: string;
    purpose: string;
    version: number;
    language?: string;
    domain: string;
    sampleCount?: number;
    annotationPolicy?: unknown;
    status?: string;
  }): Promise<EvalSetModel>;
  listEvalSets(purpose: string): Promise<EvalSetModel[]>;
}

export interface ToolPolicyModel {
  id: string;
  purpose: string;
  toolName: string;
  scope: string;
  approvalMode: string;
  timeoutMs?: number | null;
  quota?: number | null;
  version: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface EvalSetModel {
  id: string;
  purpose: string;
  version: number;
  language: string;
  domain: string;
  sampleCount: number;
  annotationPolicy?: unknown;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnalyticsEventModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  eventName: string;
  eventSchemaVersion: number;
  occurredAt: string;
  analyticsSubjectId: string;
  context?: unknown;
  privacyClass: string;
}
