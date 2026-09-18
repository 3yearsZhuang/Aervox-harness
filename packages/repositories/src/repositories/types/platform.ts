/**
 * Aervox｜思隅 @aervox/repositories — platform 仓储类型（自 types.ts 机械拆分）
 */
import type { AuditRecordModel, ContextManifestModel, ModelRunModel, NotificationModel, PromptVersionModel, ScheduledJobModel } from "./provenance.js";
import type { LocalContext } from "../../local-context.js";

export interface IPlatformRepository {
  createScheduledJob(
    ctx: LocalContext,
    job: { id: string; jobType: string; subjectId: string; idempotencyKey: string; runAt: string },
  ): Promise<ScheduledJobModel>;
  markJobDone(ctx: LocalContext, id: string): Promise<ScheduledJobModel | null>;
  createNotification(
    ctx: LocalContext,
    notification: { id: string; type: string; scheduledAt: string; channel: string; payload?: unknown },
  ): Promise<NotificationModel>;
  markNotificationSent(ctx: LocalContext, id: string): Promise<NotificationModel | null>;
  listNotifications(ctx: LocalContext, limit?: number): Promise<NotificationModel[]>;
  createPromptVersion(
    version: { id: string; purpose: string; version: number; checksum: string; status?: string },
  ): Promise<PromptVersionModel>;
  getPromptVersion(purpose: string, version: number): Promise<PromptVersionModel | null>;
  createModelRun(
    ctx: LocalContext,
    run: {
      id: string;
      purpose: string;
      provider: string;
      modelId: string;
      promptVersionId?: string | null;
    },
  ): Promise<ModelRunModel>;
  completeModelRun(
    ctx: LocalContext,
    id: string,
    result: { latencyMs?: number; tokenUsage?: unknown; cost?: number; status?: string },
  ): Promise<ModelRunModel | null>;
  attachContextManifest(ctx: LocalContext, modelRunId: string, manifestId: string): Promise<ModelRunModel | null>;
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
    ctx: LocalContext,
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
  listAuditRecords(ctx: LocalContext, limit?: number): Promise<AuditRecordModel[]>;
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
  eventName: string;
  eventSchemaVersion: number;
  occurredAt: string;
  analyticsSubjectId: string;
  context?: unknown;
  privacyClass: string;
}
