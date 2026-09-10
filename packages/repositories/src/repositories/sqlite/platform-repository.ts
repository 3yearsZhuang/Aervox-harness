/**
 * Aervox｜思隅 @aervox/database — 平台/运营域 SQLite 仓储实现
 *
 * 规则依据：docs/reference/PRD.md §8（ScheduledJob/Notification/PromptVersion/ModelRun/ContextManifest/AuditRecord）
 */
import { eq, and, desc } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import {
  scheduledJobs,
  notifications,
  promptVersions,
  modelRuns,
  contextManifests,
  auditRecords,
  toolPolicies,
  evalSets,
} from "@aervox/schema";
import type { LocalContext } from "../../local-context.js";
import type {
  IPlatformRepository,
  ScheduledJobModel,
  NotificationModel,
  PromptVersionModel,
  ModelRunModel,
  ContextManifestModel,
  AuditRecordModel,
  ToolPolicyModel,
  EvalSetModel,
} from "../types/index.js";

export class SqlitePlatformRepository implements IPlatformRepository {
  constructor(private readonly db: AervoxDatabase) {}

  async createScheduledJob(
    tenant: LocalContext,
    jobData: { id: string; jobType: string; subjectId: string; idempotencyKey: string; runAt: string },
  ): Promise<ScheduledJobModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(scheduledJobs)
      .values({
        id: jobData.id,
        jobType: jobData.jobType,
        subjectId: jobData.subjectId,
        idempotencyKey: jobData.idempotencyKey,
        runAt: jobData.runAt,
        status: "scheduled",
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as ScheduledJobModel;
  }

  async markJobDone(tenant: LocalContext, id: string): Promise<ScheduledJobModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(scheduledJobs)
      .set({ status: "done", updatedAt: now })
      .where(
        and(
          eq(scheduledJobs.id, id),
        ),
      )
      .returning();
    return (updated as ScheduledJobModel) ?? null;
  }

  async createNotification(
    tenant: LocalContext,
    notificationData: { id: string; type: string; scheduledAt: string; channel: string },
  ): Promise<NotificationModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(notifications)
      .values({
        id: notificationData.id,
        type: notificationData.type,
        scheduledAt: notificationData.scheduledAt,
        channel: notificationData.channel,
        status: "scheduled",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as NotificationModel;
  }

  async markNotificationSent(tenant: LocalContext, id: string): Promise<NotificationModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(notifications)
      .set({ status: "sent", sentAt: now, updatedAt: now })
      .where(
        and(
          eq(notifications.id, id),
        ),
      )
      .returning();
    return (updated as NotificationModel) ?? null;
  }

  async listNotifications(tenant: LocalContext, limit: number = 50): Promise<NotificationModel[]> {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(
        and(
        ),
      )
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
    return rows as NotificationModel[];
  }

  async createPromptVersion(
    versionData: { id: string; purpose: string; version: number; checksum: string; status?: string },
  ): Promise<PromptVersionModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(promptVersions)
      .values({
        id: versionData.id,
        purpose: versionData.purpose,
        version: versionData.version,
        checksum: versionData.checksum,
        status: versionData.status ?? "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as PromptVersionModel;
  }

  async getPromptVersion(purpose: string, version: number): Promise<PromptVersionModel | null> {
    const [found] = await this.db
      .select()
      .from(promptVersions)
      .where(
        and(eq(promptVersions.purpose, purpose), eq(promptVersions.version, version)),
      );
    return (found as PromptVersionModel) ?? null;
  }

  async createModelRun(
    tenant: LocalContext,
    runData: {
      id: string;
      /** 阶段 7（ADR-017）：Attempt/Step 关联（Loop Step 级写入；非 Loop 场景省略） */
      attemptId?: string | null;
      stepId?: number | null;
      purpose: string;
      provider: string;
      modelId: string;
      promptVersionId?: string | null;
    },
  ): Promise<ModelRunModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(modelRuns)
      .values({
        id: runData.id,
        attemptId: runData.attemptId ?? null,
        stepId: runData.stepId ?? null,
        purpose: runData.purpose,
        provider: runData.provider,
        modelId: runData.modelId,
        promptVersionId: runData.promptVersionId ?? null,
        status: "started",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as ModelRunModel;
  }

  async completeModelRun(
    tenant: LocalContext,
    id: string,
    result: { latencyMs?: number; tokenUsage?: unknown; cost?: number; status?: string },
  ): Promise<ModelRunModel | null> {
    const now = new Date().toISOString();
    const updateData: Record<string, unknown> = { updatedAt: now };
    if (result.status) updateData.status = result.status;
    else updateData.status = "completed";
    if (result.latencyMs !== undefined) updateData.latencyMs = result.latencyMs;
    if (result.tokenUsage !== undefined) updateData.tokenUsage = result.tokenUsage;
    if (result.cost !== undefined) updateData.cost = result.cost;
    const [updated] = await this.db
      .update(modelRuns)
      .set(updateData)
      .where(
        and(
          eq(modelRuns.id, id),
        ),
      )
      .returning();
    return (updated as ModelRunModel) ?? null;
  }

  async attachContextManifest(
    tenant: LocalContext,
    modelRunId: string,
    manifestId: string,
  ): Promise<ModelRunModel | null> {
    const now = new Date().toISOString();
    const [updated] = await this.db
      .update(modelRuns)
      .set({ contextManifestId: manifestId, updatedAt: now })
      .where(
        and(
          eq(modelRuns.id, modelRunId),
        ),
      )
      .returning();
    return (updated as ModelRunModel) ?? null;
  }

  async createContextManifest(
    manifestData: {
      id: string;
      modelRunId: string;
      purpose: string;
      sourceArtifactId: string;
      sourceRevisionId: string;
      selectionReason?: string | null;
      permissionSnapshot?: unknown;
      /** 阶段 7（ADR-017）：上下文快照（可空；多来源为多行 entries） */
      snapshot?: unknown;
      tokenBudget?: number | null;
    },
  ): Promise<ContextManifestModel> {
    const [created] = await this.db
      .insert(contextManifests)
      .values({
        id: manifestData.id,
        modelRunId: manifestData.modelRunId,
        purpose: manifestData.purpose,
        sourceArtifactId: manifestData.sourceArtifactId,
        sourceRevisionId: manifestData.sourceRevisionId,
        selectionReason: manifestData.selectionReason ?? null,
        permissionSnapshot: manifestData.permissionSnapshot ?? null,
        snapshotJson: manifestData.snapshot ?? null,
        tokenBudget: manifestData.tokenBudget ?? null,
        createdAt: new Date().toISOString(),
      })
      .returning();
    if (!created) throw new Error("createContextManifest: insert returned no row");
    // 行字段 snapshotJson → 模型字段 snapshot 映射
    const row = created as unknown as ContextManifestModel & { snapshotJson?: unknown };
    return { ...row, snapshot: row.snapshotJson ?? null, snapshotJson: undefined } as ContextManifestModel;
  }

  async createAuditRecord(
    tenant: LocalContext,
    recordData: {
      id: string;
      actorType: string;
      actorId: string;
      action: string;
      subjectType: string;
      subjectId: string;
      metadata?: unknown;
    },
  ): Promise<AuditRecordModel> {
    const [created] = await this.db
      .insert(auditRecords)
      .values({
        id: recordData.id,
        actorType: recordData.actorType,
        actorId: recordData.actorId,
        action: recordData.action,
        subjectType: recordData.subjectType,
        subjectId: recordData.subjectId,
        metadata: recordData.metadata ?? null,
        createdAt: new Date().toISOString(),
      })
      .returning();
    return created as AuditRecordModel;
  }

  async listAuditRecords(tenant: LocalContext, limit: number = 50): Promise<AuditRecordModel[]> {
    const rows = await this.db
      .select()
      .from(auditRecords)
      .where(
        and(
        ),
      )
      .orderBy(desc(auditRecords.createdAt))
      .limit(limit);
    return rows as AuditRecordModel[];
  }

  // ============ MVP 补齐（PRD §8）：工具策略 + 评估集（系统级，无租户列） ============

  async createToolPolicy(policyData: {
    id: string;
    purpose: string;
    toolName: string;
    scope?: string;
    approvalMode?: string;
    timeoutMs?: number | null;
    quota?: number | null;
    version?: number;
    status?: string;
  }): Promise<ToolPolicyModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(toolPolicies)
      .values({
        id: policyData.id,
        purpose: policyData.purpose,
        toolName: policyData.toolName,
        scope: policyData.scope ?? "all",
        approvalMode: policyData.approvalMode ?? "auto",
        timeoutMs: policyData.timeoutMs ?? null,
        quota: policyData.quota ?? null,
        version: policyData.version ?? 1,
        status: policyData.status ?? "active",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as ToolPolicyModel;
  }

  async getToolPolicy(purpose: string, toolName: string, version: number): Promise<ToolPolicyModel | null> {
    const [found] = await this.db
      .select()
      .from(toolPolicies)
      .where(
        and(
          eq(toolPolicies.purpose, purpose),
          eq(toolPolicies.toolName, toolName),
          eq(toolPolicies.version, version),
        ),
      );
    return (found as ToolPolicyModel) ?? null;
  }

  async createEvalSet(evalSetData: {
    id: string;
    purpose: string;
    version: number;
    language?: string;
    domain: string;
    sampleCount?: number;
    annotationPolicy?: unknown;
    status?: string;
  }): Promise<EvalSetModel> {
    const now = new Date().toISOString();
    const [created] = await this.db
      .insert(evalSets)
      .values({
        id: evalSetData.id,
        purpose: evalSetData.purpose,
        version: evalSetData.version,
        language: evalSetData.language ?? "zh-CN",
        domain: evalSetData.domain,
        sampleCount: evalSetData.sampleCount ?? 0,
        annotationPolicy: evalSetData.annotationPolicy ?? null,
        status: evalSetData.status ?? "draft",
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as EvalSetModel;
  }

  async listEvalSets(purpose: string): Promise<EvalSetModel[]> {
    const rows = await this.db
      .select()
      .from(evalSets)
      .where(eq(evalSets.purpose, purpose))
      .orderBy(desc(evalSets.version));
    return rows as EvalSetModel[];
  }
}
