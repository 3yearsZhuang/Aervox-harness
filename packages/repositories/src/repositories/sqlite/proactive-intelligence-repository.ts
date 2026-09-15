/** CAP-033/034/035 local proactive intelligence repository. */
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { AervoxDatabase } from "../../client.js";
import type { ProactiveVaultCipher } from "../../proactive-vault-crypto.js";
import {
  proactiveActionVerifications,
  proactiveAttentionStates,
  proactiveClaimConflicts,
  proactiveCommitments,
  proactiveDriftSignals,
  proactiveExternalConnections,
  proactiveHealthSamples,
  proactiveHomeEntities,
  proactivePreparationBundles,
  proactiveProjects,
  proactiveRelationships,
  proactiveReviewReports,
  proactiveSceneSnapshots,
  proactiveTimelineEvents,
  proactiveTriggerEvents,
  proactiveTriggerRules,
  proactiveWorkflowTemplates,
} from "@aervox/schema";
import type { LocalContext } from "../../local-context.js";

const MAX_LIMIT = 500;
const limitOf = (value: number | undefined, fallback = 100): number =>
  Math.max(1, Math.min(MAX_LIMIT, Math.floor(value ?? fallback)));

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function stringify(value: unknown, fallback = "{}"): string {
  try {
    return JSON.stringify(value ?? JSON.parse(fallback));
  } catch {
    return fallback;
  }
}

function bool(value: unknown): boolean {
  return value === true || value === 1;
}

export interface IntelligenceTimelineEvent {
  id: string;
  revisionId: string;
  sourceGrantId?: string | null;
  sourceKey: string;
  eventType: string;
  subjectKey: string;
  title: string;
  summary?: string | null;
  payload: unknown;
  privacyClass: string;
  projectId?: string | null;
  relationshipId?: string | null;
  checksum: string;
  occurredAt: string;
  createdAt: string;
}

export interface IntelligenceProject {
  id: string;
  revisionId: string;
  title: string;
  objective?: string | null;
  description?: string | null;
  status: string;
  priority: number;
  confidence: number;
  dueAt?: string | null;
  lastActivityAt?: string | null;
  sourceTimelineIds: string[];
  createdAt: string;
  updatedAt: string;
}

type TimelineEventInput = Omit<IntelligenceTimelineEvent, "createdAt">;

export interface IntelligenceCommitment {
  id: string;
  revisionId: string;
  projectId?: string | null;
  relationshipId?: string | null;
  content: string;
  status: string;
  importance: number;
  dueAt?: string | null;
  sourceTimelineId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntelligenceWorkflow {
  id: string;
  revisionId: string;
  name: string;
  description?: string | null;
  state: string;
  trigger: unknown;
  steps: unknown[];
  evidenceCount: number;
  successCount: number;
  failureCount: number;
  lastObservedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntelligenceTriggerRule {
  id: string;
  revisionId: string;
  /** 归属插件（CR-032 物化模式；内置规则为 null） */
  pluginId?: string | null;
  name: string;
  triggerType: string;
  condition: unknown;
  action: unknown;
  enabled: boolean;
  cooldownSeconds: number;
  quietHours: unknown;
  lastTriggeredAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IntelligenceConnection {
  id: string;
  revisionId: string;
  provider: "home_assistant" | "xiaomi_health" | string;
  displayName: string;
  endpoint?: string | null;
  authType: string;
  scopes: string[];
  settings: Record<string, unknown>;
  state: string;
  lastSyncAt?: string | null;
  lastError?: string | null;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface IntelligenceConnectionSecret extends IntelligenceConnection {
  credential: Record<string, unknown>;
}

export interface IntelligenceSnapshot {
  exportedAt: string;
  timeline: IntelligenceTimelineEvent[];
  projects: IntelligenceProject[];
  commitments: IntelligenceCommitment[];
  relationships: unknown[];
  workflows: IntelligenceWorkflow[];
  triggerRules: IntelligenceTriggerRule[];
  triggerEvents: unknown[];
  verifications: unknown[];
  conflicts: unknown[];
  preparations: unknown[];
  attentionStates: unknown[];
  driftSignals: unknown[];
  scenes: unknown[];
  reviews: unknown[];
  connections: IntelligenceConnection[];
  homeEntities: unknown[];
  healthSamples: unknown[];
}

export class SqliteProactiveIntelligenceRepository {
  constructor(
    private readonly db: AervoxDatabase,
    private readonly cipher?: ProactiveVaultCipher,
  ) {}

  private encrypt(value: string | null | undefined, type: string, id: string): string | null {
    if (value === null || value === undefined) return null;
    if (!this.cipher || this.cipher.isEncrypted(value)) return value;
    return this.cipher.encrypt(value, `${type}:${id}`);
  }

  private decrypt(value: string | null | undefined, type: string, id: string): string | null {
    if (value === null || value === undefined) return null;
    if (!this.cipher || !this.cipher.isEncrypted(value)) return value;
    return this.cipher.decrypt(value, `${type}:${id}`);
  }

  async createTimelineEvent(
    tenant: LocalContext,
    input: TimelineEventInput,
  ): Promise<IntelligenceTimelineEvent> {
    const now = new Date().toISOString();
    const [created] = await this.db.insert(proactiveTimelineEvents).values({
      id: input.id,
      revisionId: input.revisionId,
      sourceGrantId: input.sourceGrantId ?? null,
      sourceKey: input.sourceKey,
      eventType: input.eventType,
      subjectKey: this.encrypt(input.subjectKey, "timeline", input.id) ?? "",
      title: this.encrypt(input.title, "timeline", input.id) ?? "",
      summary: this.encrypt(input.summary, "timeline", input.id),
      payloadJson: this.encrypt(stringify(input.payload), "timeline", input.id) ?? "{}",
      privacyClass: input.privacyClass,
      projectId: input.projectId ?? null,
      relationshipId: input.relationshipId ?? null,
      checksum: input.checksum,
      processingBoundary: "local_only",
      occurredAt: input.occurredAt,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing({target: proactiveTimelineEvents.checksum}).returning();
    if (created) return this.timelineModel(created);
    const [existing] = await this.db
      .select()
      .from(proactiveTimelineEvents)
      .where(eq(proactiveTimelineEvents.checksum, input.checksum))
      .limit(1);
    if (existing) return this.timelineModel(existing);
    throw new Error("failed to create proactive timeline event");
  }

  /**
   * 批量写入时间线事件。时间线以 checksum 幂等；冲突行由 SQLite 直接忽略，
   * 避免主动智能周期对每条观察各执行一次 SELECT→INSERT 往返。
   */
  async createTimelineEvents(
    tenant: LocalContext,
    inputs: TimelineEventInput[],
  ): Promise<IntelligenceTimelineEvent[]> {
    if (inputs.length === 0) return [];
    const now = new Date().toISOString();
    const rows = await this.db.insert(proactiveTimelineEvents).values(inputs.map((input) => ({
      id: input.id,
      revisionId: input.revisionId,
      sourceGrantId: input.sourceGrantId ?? null,
      sourceKey: input.sourceKey,
      eventType: input.eventType,
      subjectKey: this.encrypt(input.subjectKey, "timeline", input.id) ?? "",
      title: this.encrypt(input.title, "timeline", input.id) ?? "",
      summary: this.encrypt(input.summary, "timeline", input.id),
      payloadJson: this.encrypt(stringify(input.payload), "timeline", input.id) ?? "{}",
      privacyClass: input.privacyClass,
      projectId: input.projectId ?? null,
      relationshipId: input.relationshipId ?? null,
      checksum: input.checksum,
      processingBoundary: "local_only" as const,
      occurredAt: input.occurredAt,
      createdAt: now,
      updatedAt: now,
    }))).onConflictDoNothing({target: proactiveTimelineEvents.checksum}).returning();
    return rows.map((row) => this.timelineModel(row));
  }

  async listTimeline(
    tenant: LocalContext,
    options: { from?: string; to?: string; sourceKey?: string; projectId?: string; limit?: number } = {},
  ): Promise<IntelligenceTimelineEvent[]> {
    const conditions = [
    ];
    if (options.from) conditions.push(gte(proactiveTimelineEvents.occurredAt, options.from));
    if (options.to) conditions.push(lte(proactiveTimelineEvents.occurredAt, options.to));
    if (options.sourceKey) conditions.push(eq(proactiveTimelineEvents.sourceKey, options.sourceKey));
    if (options.projectId) conditions.push(eq(proactiveTimelineEvents.projectId, options.projectId));
    const rows = await this.db.select().from(proactiveTimelineEvents)
      .where(and(...conditions)).orderBy(desc(proactiveTimelineEvents.occurredAt))
      .limit(limitOf(options.limit));
    return rows.map((row) => this.timelineModel(row));
  }

  async upsertProject(
    tenant: LocalContext,
    input: Omit<IntelligenceProject, "createdAt" | "updatedAt">,
  ): Promise<IntelligenceProject> {
    const now = new Date().toISOString();
    const values = {
      revisionId: input.revisionId,
      title: this.encrypt(input.title, "project", input.id) ?? "",
      objective: this.encrypt(input.objective, "project", input.id),
      description: this.encrypt(input.description, "project", input.id),
      status: input.status,
      priority: input.priority,
      confidence: input.confidence,
      dueAt: input.dueAt ?? null,
      lastActivityAt: input.lastActivityAt ?? null,
      sourceTimelineIdsJson: JSON.stringify(input.sourceTimelineIds),
      processingBoundary: "local_only",
      updatedAt: now,
    };
    const [existing] = await this.db.select().from(proactiveProjects).where(and(
      eq(proactiveProjects.id, input.id),
    )).limit(1);
    const [row] = existing
      ? await this.db.update(proactiveProjects).set(values).where(eq(proactiveProjects.id, input.id)).returning()
      : await this.db.insert(proactiveProjects).values({
        id: input.id,
        createdAt: now,
        ...values,
      }).returning();
    if (!row) throw new Error("failed to upsert proactive project");
    return this.projectModel(row);
  }

  async listProjects(tenant: LocalContext, status?: string, limit?: number): Promise<IntelligenceProject[]> {
    const conditions = [];
    if (status) conditions.push(eq(proactiveProjects.status, status));
    const rows = await this.db.select().from(proactiveProjects).where(and(...conditions))
      .orderBy(desc(proactiveProjects.lastActivityAt)).limit(limitOf(limit));
    return rows.map((row) => this.projectModel(row));
  }

  async upsertRelationship(tenant: LocalContext, input: {
    id: string; revisionId: string; relationshipType: string; displayName: string; notes?: string | null;
    state?: string; confidence?: number; lastInteractionAt?: string | null; sourceGrantIds?: string[];
  }) {
    const now = new Date().toISOString();
    const values = {
      revisionId: input.revisionId,
      relationshipType: input.relationshipType,
      displayName: this.encrypt(input.displayName, "relationship", input.id) ?? "",
      notes: this.encrypt(input.notes, "relationship", input.id),
      state: input.state ?? "active",
      confidence: input.confidence ?? 0,
      lastInteractionAt: input.lastInteractionAt ?? null,
      sourceGrantIdsJson: JSON.stringify(input.sourceGrantIds ?? []),
      processingBoundary: "local_only",
      updatedAt: now,
    };
    const [existing] = await this.db.select().from(proactiveRelationships).where(eq(proactiveRelationships.id, input.id)).limit(1);
    const [row] = existing
      ? await this.db.update(proactiveRelationships).set(values).where(eq(proactiveRelationships.id, input.id)).returning()
      : await this.db.insert(proactiveRelationships).values({id: input.id, createdAt: now, ...values}).returning();
    if (!row) throw new Error("failed to upsert proactive relationship");
    return this.relationshipModel(row);
  }

  async listRelationships(tenant: LocalContext, limit?: number) {
    const rows = await this.db.select().from(proactiveRelationships).where(and(
    )).orderBy(desc(proactiveRelationships.lastInteractionAt)).limit(limitOf(limit));
    return rows.map((row) => this.relationshipModel(row));
  }

  async createCommitment(tenant: LocalContext, input: Omit<IntelligenceCommitment, "createdAt" | "updatedAt">): Promise<IntelligenceCommitment> {
    const now = new Date().toISOString();
    const [row] = await this.db.insert(proactiveCommitments).values({
      id: input.id,
      revisionId: input.revisionId, projectId: input.projectId ?? null, relationshipId: input.relationshipId ?? null,
      content: this.encrypt(input.content, "commitment", input.id) ?? "", status: input.status,
      importance: input.importance, dueAt: input.dueAt ?? null, sourceTimelineId: input.sourceTimelineId ?? null,
      processingBoundary: "local_only", createdAt: now, updatedAt: now,
    }).returning();
    if (!row) throw new Error("failed to create proactive commitment");
    return this.commitmentModel(row);
  }

  async updateCommitmentStatus(tenant: LocalContext, id: string, status: string) {
    const [row] = await this.db.update(proactiveCommitments).set({status, updatedAt: new Date().toISOString()}).where(eq(proactiveCommitments.id, id)).returning();
    return row ? this.commitmentModel(row) : null;
  }

  async listCommitments(tenant: LocalContext, options: { status?: string; dueBefore?: string; limit?: number } = {}) {
    const conditions = [];
    if (options.status) conditions.push(eq(proactiveCommitments.status, options.status));
    if (options.dueBefore) conditions.push(lte(proactiveCommitments.dueAt, options.dueBefore));
    const rows = await this.db.select().from(proactiveCommitments).where(and(...conditions))
      .orderBy(asc(proactiveCommitments.dueAt)).limit(limitOf(options.limit));
    return rows.map((row) => this.commitmentModel(row));
  }

  async upsertWorkflow(tenant: LocalContext, input: Omit<IntelligenceWorkflow, "createdAt" | "updatedAt">): Promise<IntelligenceWorkflow> {
    const now = new Date().toISOString();
    const values = {
      revisionId: input.revisionId, name: this.encrypt(input.name, "workflow", input.id) ?? "",
      description: this.encrypt(input.description, "workflow", input.id), state: input.state,
      triggerJson: this.encrypt(stringify(input.trigger), "workflow", input.id) ?? "{}",
      stepsJson: this.encrypt(JSON.stringify(input.steps), "workflow", input.id) ?? "[]",
      evidenceCount: input.evidenceCount, successCount: input.successCount, failureCount: input.failureCount,
      lastObservedAt: input.lastObservedAt ?? null, processingBoundary: "local_only", updatedAt: now,
    };
    const [existing] = await this.db.select().from(proactiveWorkflowTemplates).where(eq(proactiveWorkflowTemplates.id, input.id)).limit(1);
    const [row] = existing
      ? await this.db.update(proactiveWorkflowTemplates).set(values).where(eq(proactiveWorkflowTemplates.id, input.id)).returning()
      : await this.db.insert(proactiveWorkflowTemplates).values({id: input.id, createdAt: now, ...values}).returning();
    if (!row) throw new Error("failed to upsert proactive workflow");
    return this.workflowModel(row);
  }

  async listWorkflows(tenant: LocalContext, state?: string, limit?: number): Promise<IntelligenceWorkflow[]> {
    const conditions = [];
    if (state) conditions.push(eq(proactiveWorkflowTemplates.state, state));
    const rows = await this.db.select().from(proactiveWorkflowTemplates).where(and(...conditions))
      .orderBy(desc(proactiveWorkflowTemplates.evidenceCount)).limit(limitOf(limit));
    return rows.map((row) => this.workflowModel(row));
  }

  async upsertTriggerRule(tenant: LocalContext, input: Omit<IntelligenceTriggerRule, "createdAt" | "updatedAt">): Promise<IntelligenceTriggerRule> {
    const now = new Date().toISOString();
    const [existing] = await this.db.select().from(proactiveTriggerRules).where(eq(proactiveTriggerRules.id, input.id)).limit(1);
    const values = {
      revisionId: input.revisionId, pluginId: input.pluginId ?? null,
      name: this.encrypt(input.name, "trigger-rule", input.id) ?? "",
      triggerType: input.triggerType, conditionJson: this.encrypt(stringify(input.condition), "trigger-rule", input.id) ?? "{}",
      actionJson: this.encrypt(stringify(input.action), "trigger-rule", input.id) ?? "{}", enabled: input.enabled,
      cooldownSeconds: input.cooldownSeconds, quietHoursJson: JSON.stringify(input.quietHours ?? {}),
      // undefined = 保留现值（物化器周期性 upsert 不得清空冷却状态）；null = 显式清零
      lastTriggeredAt: input.lastTriggeredAt === undefined ? existing?.lastTriggeredAt ?? null : input.lastTriggeredAt,
      processingBoundary: "local_only", updatedAt: now,
    };
    const [row] = existing
      ? await this.db.update(proactiveTriggerRules).set(values).where(eq(proactiveTriggerRules.id, input.id)).returning()
      : await this.db.insert(proactiveTriggerRules).values({id: input.id, createdAt: now, ...values}).returning();
    if (!row) throw new Error("failed to upsert proactive trigger rule");
    return this.triggerRuleModel(row);
  }

  async listTriggerRules(tenant: LocalContext, enabled?: boolean, limit?: number): Promise<IntelligenceTriggerRule[]> {
    const conditions = [];
    if (enabled !== undefined) conditions.push(eq(proactiveTriggerRules.enabled, enabled));
    const rows = await this.db.select().from(proactiveTriggerRules).where(and(...conditions))
      .orderBy(asc(proactiveTriggerRules.name)).limit(limitOf(limit));
    return rows.map((row) => this.triggerRuleModel(row));
  }

  /** CR-032：按插件列出物化规则（生命周期级联与幽灵规则排查用） */
  async listTriggerRulesByPlugin(tenant: LocalContext, pluginId: string, limit?: number): Promise<IntelligenceTriggerRule[]> {
    const rows = await this.db.select().from(proactiveTriggerRules)
      .where(eq(proactiveTriggerRules.pluginId, pluginId)).orderBy(asc(proactiveTriggerRules.name)).limit(limitOf(limit));
    return rows.map((row) => this.triggerRuleModel(row));
  }

  /** CR-032：插件启停级联——批量切换该插件物化规则的 enabled，返回受影响行数 */
  async setTriggerRulesEnabledByPlugin(tenant: LocalContext, pluginId: string, enabled: boolean): Promise<number> {
    const rows = await this.db.update(proactiveTriggerRules)
      .set({enabled, updatedAt: new Date().toISOString()})
      .where(eq(proactiveTriggerRules.pluginId, pluginId)).returning();
    return rows.length;
  }

  /** CR-032：插件卸载级联——清除该插件全部物化规则，杜绝幽灵规则 */
  async deleteTriggerRulesByPlugin(tenant: LocalContext, pluginId: string): Promise<number> {
    const rows = await this.db.delete(proactiveTriggerRules)
      .where(eq(proactiveTriggerRules.pluginId, pluginId)).returning();
    return rows.length;
  }

  /** CR-032：删除单条物化规则（声明收敛时清除已消失的触发器） */
  async deleteTriggerRule(tenant: LocalContext, ruleId: string): Promise<boolean> {
    const rows = await this.db.delete(proactiveTriggerRules)
      .where(eq(proactiveTriggerRules.id, ruleId)).returning();
    return rows.length > 0;
  }

  /** CR-032 裁决器：规则命中后写回冷却起点 */
  async updateTriggerRuleLastTriggeredAt(tenant: LocalContext, ruleId: string, lastTriggeredAt: string): Promise<void> {
    await this.db.update(proactiveTriggerRules)
      .set({lastTriggeredAt, updatedAt: new Date().toISOString()})
      .where(eq(proactiveTriggerRules.id, ruleId));
  }

  /** CR-032 裁决器：时间窗内触发事件（全局频次水位按 decision=dispatched 计数） */
  async listTriggerEventsSince(tenant: LocalContext, since: string, limit?: number) {
    const rows = await this.db.select().from(proactiveTriggerEvents)
      .where(gte(proactiveTriggerEvents.occurredAt, since))
      .orderBy(desc(proactiveTriggerEvents.occurredAt)).limit(limitOf(limit));
    return rows.map((row) => this.triggerEventModel(row));
  }

  async recordTriggerEvent(tenant: LocalContext, input: {
    id: string; revisionId: string; ruleId?: string | null; triggerType: string; cause?: unknown;
    decision: string; reason?: string | null; actionId?: string | null; occurredAt?: string;
  }) {
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const [row] = await this.db.insert(proactiveTriggerEvents).values({
      id: input.id,
      revisionId: input.revisionId, ruleId: input.ruleId ?? null, triggerType: input.triggerType,
      causeJson: this.encrypt(stringify(input.cause), "trigger-event", input.id) ?? "{}", decision: input.decision,
      reason: this.encrypt(input.reason, "trigger-event", input.id), actionId: input.actionId ?? null,
      occurredAt, processingBoundary: "local_only", createdAt: occurredAt,
    }).returning();
    return row ? this.triggerEventModel(row) : null;
  }

  async listTriggerEvents(tenant: LocalContext, limit?: number) {
    const rows = await this.db.select().from(proactiveTriggerEvents).where(and(
    )).orderBy(desc(proactiveTriggerEvents.occurredAt)).limit(limitOf(limit));
    return rows.map((row) => this.triggerEventModel(row));
  }

  async upsertActionVerification(tenant: LocalContext, input: {
    id: string; actionId: string; expected?: unknown; observed?: unknown; status: string;
    attemptCount?: number; verifiedAt?: string | null; error?: string | null;
  }) {
    const now = new Date().toISOString();
    const values = {
      expectedJson: this.encrypt(stringify(input.expected), "verification", input.id) ?? "{}",
      observedJson: input.observed === undefined ? null : this.encrypt(stringify(input.observed), "verification", input.id),
      status: input.status, attemptCount: input.attemptCount ?? 0, verifiedAt: input.verifiedAt ?? null,
      error: this.encrypt(input.error, "verification", input.id), processingBoundary: "local_only", updatedAt: now,
    };
    const [existing] = await this.db.select().from(proactiveActionVerifications).where(eq(proactiveActionVerifications.id, input.id)).limit(1);
    const id = existing?.id ?? input.id;
    const encryptedValues = id === input.id ? values : {
      ...values,
      expectedJson: this.encrypt(stringify(input.expected), "verification", id) ?? "{}",
      observedJson: input.observed === undefined ? null : this.encrypt(stringify(input.observed), "verification", id),
      error: this.encrypt(input.error, "verification", id),
    };
    const [row] = existing
      ? await this.db.update(proactiveActionVerifications).set(encryptedValues).where(eq(proactiveActionVerifications.id, id)).returning()
      : await this.db.insert(proactiveActionVerifications).values({id, actionId: input.actionId, createdAt: now, ...encryptedValues}).returning();
    return row ? this.verificationModel(row) : null;
  }

  async listActionVerifications(tenant: LocalContext, status?: string, limit?: number) {
    const conditions = [];
    if (status) conditions.push(eq(proactiveActionVerifications.status, status));
    const rows = await this.db.select().from(proactiveActionVerifications).where(and(...conditions))
      .orderBy(desc(proactiveActionVerifications.updatedAt)).limit(limitOf(limit));
    return rows.map((row) => this.verificationModel(row));
  }

  async createClaimConflict(tenant: LocalContext, input: {
    id: string; revisionId: string; primaryClaimId: string; conflictingClaimId: string; reason: string;
  }) {
    const now = new Date().toISOString();
    const [row] = await this.db.insert(proactiveClaimConflicts).values({
      id: input.id,
      revisionId: input.revisionId, primaryClaimId: input.primaryClaimId, conflictingClaimId: input.conflictingClaimId,
      reason: this.encrypt(input.reason, "claim-conflict", input.id) ?? "", status: "open", resolution: null,
      resolvedAt: null, processingBoundary: "local_only", createdAt: now, updatedAt: now,
    }).onConflictDoNothing({
      target: [proactiveClaimConflicts.primaryClaimId, proactiveClaimConflicts.conflictingClaimId],
    }).returning();
    if (row) return this.conflictModel(row);
    const [existing] = await this.db.select().from(proactiveClaimConflicts).where(and(
      eq(proactiveClaimConflicts.primaryClaimId, input.primaryClaimId),
      eq(proactiveClaimConflicts.conflictingClaimId, input.conflictingClaimId),
    )).limit(1);
    return existing ? this.conflictModel(existing) : null;
  }

  /** 批量写入冲突键；SQLite 负责幂等去重，避免每个 claim pair 一次往返。 */
  async createClaimConflicts(tenant: LocalContext, inputs: Array<{
    id: string;
    revisionId: string;
    primaryClaimId: string;
    conflictingClaimId: string;
    reason: string;
  }>): Promise<number> {
    if (inputs.length === 0) return 0;
    const now = new Date().toISOString();
    let inserted = 0;
    // SQLite 的绑定参数有上限；分块保持大画像也能稳定处理。
    for (let offset = 0; offset < inputs.length; offset += 200) {
      const chunk = inputs.slice(offset, offset + 200);
      const rows = await this.db.insert(proactiveClaimConflicts).values(chunk.map((input) => ({
        id: input.id,
        revisionId: input.revisionId,
        primaryClaimId: input.primaryClaimId,
        conflictingClaimId: input.conflictingClaimId,
        reason: this.encrypt(input.reason, "claim-conflict", input.id) ?? "",
        status: "open",
        resolution: null,
        resolvedAt: null,
        processingBoundary: "local_only" as const,
        createdAt: now,
        updatedAt: now,
      }))).onConflictDoNothing({
        target: [proactiveClaimConflicts.primaryClaimId, proactiveClaimConflicts.conflictingClaimId],
      }).returning({id: proactiveClaimConflicts.id});
      inserted += rows.length;
    }
    return inserted;
  }

  async resolveClaimConflict(tenant: LocalContext, id: string, resolution: string) {
    const now = new Date().toISOString();
    const [row] = await this.db.update(proactiveClaimConflicts).set({
      status: "resolved", resolution: this.encrypt(resolution, "claim-conflict", id), resolvedAt: now, updatedAt: now,
    }).where(and(eq(proactiveClaimConflicts.id, id), )).returning();
    return row ? this.conflictModel(row) : null;
  }

  async listClaimConflicts(tenant: LocalContext, status?: string, limit?: number) {
    const conditions = [];
    if (status) conditions.push(eq(proactiveClaimConflicts.status, status));
    const rows = await this.db.select().from(proactiveClaimConflicts).where(and(...conditions))
      .orderBy(desc(proactiveClaimConflicts.createdAt)).limit(limitOf(limit));
    return rows.map((row) => this.conflictModel(row));
  }

  /** 仅读取冲突键，不解密 reason/resolution；供周期性去重检查使用。 */
  async listClaimConflictKeys(tenant: LocalContext, revisionId?: string): Promise<Array<{
    revisionId: string;
    primaryClaimId: string;
    conflictingClaimId: string;
    status: string;
  }>> {
    const conditions = [];
    if (revisionId) conditions.push(eq(proactiveClaimConflicts.revisionId, revisionId));
    const rows = await this.db.select({
      revisionId: proactiveClaimConflicts.revisionId,
      primaryClaimId: proactiveClaimConflicts.primaryClaimId,
      conflictingClaimId: proactiveClaimConflicts.conflictingClaimId,
      status: proactiveClaimConflicts.status,
    }).from(proactiveClaimConflicts).where(and(...conditions));
    return rows;
  }

  /** 统计冲突数量而不实例化/解密全部冲突正文。 */
  async countClaimConflicts(tenant: LocalContext, status?: string, revisionId?: string): Promise<number> {
    const conditions = [];
    if (status) conditions.push(eq(proactiveClaimConflicts.status, status));
    if (revisionId) conditions.push(eq(proactiveClaimConflicts.revisionId, revisionId));
    const [row] = await this.db.select({count: sql<number>`count(*)`})
      .from(proactiveClaimConflicts).where(and(...conditions));
    return Number(row?.count ?? 0);
  }

  async createPreparation(tenant: LocalContext, input: {
    id: string; revisionId: string; projectId?: string | null; commitmentId?: string | null;
    title: string; bundle: unknown; status?: string; availableAt?: string; expiresAt?: string | null;
  }) {
    const now = new Date().toISOString();
    const [row] = await this.db.insert(proactivePreparationBundles).values({
      id: input.id, revisionId: input.revisionId,
      projectId: input.projectId ?? null, commitmentId: input.commitmentId ?? null,
      title: this.encrypt(input.title, "preparation", input.id) ?? "",
      bundleJson: this.encrypt(stringify(input.bundle), "preparation", input.id) ?? "{}", status: input.status ?? "ready",
      availableAt: input.availableAt ?? now, expiresAt: input.expiresAt ?? null, processingBoundary: "local_only",
      createdAt: now, updatedAt: now,
    }).onConflictDoNothing({target: proactivePreparationBundles.id}).returning();
    return row ? this.preparationModel(row) : null;
  }

  async listPreparations(tenant: LocalContext, status?: string, limit?: number) {
    const conditions = [];
    if (status) conditions.push(eq(proactivePreparationBundles.status, status));
    const rows = await this.db.select().from(proactivePreparationBundles).where(and(...conditions)).orderBy(desc(proactivePreparationBundles.availableAt)).limit(limitOf(limit));
    return rows.map((row) => this.preparationModel(row));
  }

  async createAttentionState(tenant: LocalContext, input: {
    id: string; revisionId: string; windowStart: string; windowEnd: string; focusScore: number; fatigueScore: number;
    contextSwitches?: number; errorSignals?: number; recommendation?: string | null; evidence?: unknown[];
  }) {
    const now = new Date().toISOString();
    const [row] = await this.db.insert(proactiveAttentionStates).values({
      id: input.id, revisionId: input.revisionId,
      windowStart: input.windowStart, windowEnd: input.windowEnd, focusScore: input.focusScore, fatigueScore: input.fatigueScore,
      contextSwitches: input.contextSwitches ?? 0, errorSignals: input.errorSignals ?? 0,
      recommendation: this.encrypt(input.recommendation, "attention", input.id),
      evidenceJson: this.encrypt(JSON.stringify(input.evidence ?? []), "attention", input.id) ?? "[]",
      processingBoundary: "local_only", createdAt: now, updatedAt: now,
    }).onConflictDoNothing({target: proactiveAttentionStates.id}).returning();
    return row ? this.attentionModel(row) : null;
  }

  async listAttentionStates(tenant: LocalContext, limit?: number) {
    const rows = await this.db.select().from(proactiveAttentionStates).where(and(
    )).orderBy(desc(proactiveAttentionStates.windowEnd)).limit(limitOf(limit));
    return rows.map((row) => this.attentionModel(row));
  }

  async createDriftSignal(tenant: LocalContext, input: {
    id: string; revisionId: string; signalType: string; projectId?: string | null; expected?: unknown; actual?: unknown;
    severity: number; state?: string; explanation?: string | null; detectedAt?: string;
  }) {
    const now = new Date().toISOString();
    const [row] = await this.db.insert(proactiveDriftSignals).values({
      id: input.id, revisionId: input.revisionId,
      signalType: input.signalType, projectId: input.projectId ?? null,
      expectedJson: this.encrypt(stringify(input.expected), "drift", input.id) ?? "{}",
      actualJson: this.encrypt(stringify(input.actual), "drift", input.id) ?? "{}",
      severity: input.severity, state: input.state ?? "open", explanation: this.encrypt(input.explanation, "drift", input.id),
      detectedAt: input.detectedAt ?? now, processingBoundary: "local_only", createdAt: now, updatedAt: now,
    }).onConflictDoNothing({target: proactiveDriftSignals.id}).returning();
    return row ? this.driftModel(row) : null;
  }

  async listDriftSignals(tenant: LocalContext, state?: string, limit?: number) {
    const conditions = [];
    if (state) conditions.push(eq(proactiveDriftSignals.state, state));
    const rows = await this.db.select().from(proactiveDriftSignals).where(and(...conditions)).orderBy(desc(proactiveDriftSignals.detectedAt)).limit(limitOf(limit));
    return rows.map((row) => this.driftModel(row));
  }

  async createScene(tenant: LocalContext, input: {
    id: string; revisionId: string; sceneType: string; applicationId?: string | null; payload?: unknown;
    checksum: string; capturedAt?: string;
  }) {
    const now = new Date().toISOString();
    const [row] = await this.db.insert(proactiveSceneSnapshots).values({
      id: input.id, revisionId: input.revisionId,
      sceneType: input.sceneType, applicationId: input.applicationId ?? null,
      payloadJson: this.encrypt(stringify(input.payload), "scene", input.id) ?? "{}", checksum: input.checksum,
      capturedAt: input.capturedAt ?? now, processingBoundary: "local_only", createdAt: now, updatedAt: now,
    }).onConflictDoNothing({target: proactiveSceneSnapshots.checksum}).returning();
    if (row) return this.sceneModel(row);
    const [existing] = await this.db.select().from(proactiveSceneSnapshots).where(eq(proactiveSceneSnapshots.checksum, input.checksum)).limit(1);
    return existing ? this.sceneModel(existing) : null;
  }

  async listScenes(tenant: LocalContext, limit?: number) {
    const rows = await this.db.select().from(proactiveSceneSnapshots).where(and(
    )).orderBy(desc(proactiveSceneSnapshots.capturedAt)).limit(limitOf(limit));
    return rows.map((row) => this.sceneModel(row));
  }

  async upsertReview(tenant: LocalContext, input: {
    id: string; revisionId: string; periodType: string; periodStart: string; periodEnd: string;
    summary: string; metrics?: unknown; recommendations?: unknown[];
  }) {
    const now = new Date().toISOString();
    const [existing] = await this.db.select().from(proactiveReviewReports).where(and(
      eq(proactiveReviewReports.periodType, input.periodType), eq(proactiveReviewReports.periodStart, input.periodStart),
      eq(proactiveReviewReports.periodEnd, input.periodEnd),
    )).limit(1);
    const id = existing?.id ?? input.id;
    const values = {
      revisionId: input.revisionId, summary: this.encrypt(input.summary, "review", id) ?? "",
      metricsJson: this.encrypt(stringify(input.metrics), "review", id) ?? "{}",
      recommendationsJson: this.encrypt(JSON.stringify(input.recommendations ?? []), "review", id) ?? "[]",
      processingBoundary: "local_only", updatedAt: now,
    };
    const [row] = existing
      ? await this.db.update(proactiveReviewReports).set(values).where(eq(proactiveReviewReports.id, id)).returning()
      : await this.db.insert(proactiveReviewReports).values({id, periodType: input.periodType, periodStart: input.periodStart, periodEnd: input.periodEnd, createdAt: now, ...values}).returning();
    return row ? this.reviewModel(row) : null;
  }

  async listReviews(tenant: LocalContext, limit?: number) {
    const rows = await this.db.select().from(proactiveReviewReports).where(and(
    )).orderBy(desc(proactiveReviewReports.periodEnd)).limit(limitOf(limit));
    return rows.map((row) => this.reviewModel(row));
  }

  async upsertConnection(tenant: LocalContext, input: {
    id: string; revisionId: string; provider: string; displayName: string; endpoint?: string | null;
    authType: string; credential?: Record<string, unknown>; scopes?: string[]; settings?: Record<string, unknown>;
    state?: string; lastSyncAt?: string | null; lastError?: string | null;
  }): Promise<IntelligenceConnection> {
    const now = new Date().toISOString();
    const [existing] = await this.db.select().from(proactiveExternalConnections).where(eq(proactiveExternalConnections.id, input.id)).limit(1);
    const values = {
      revisionId: input.revisionId, provider: input.provider,
      displayName: this.encrypt(input.displayName, "connection", input.id) ?? "",
      endpoint: input.endpoint ?? null, authType: input.authType,
      credentialJson: input.credential === undefined && existing
        ? existing.credentialJson
        : this.encrypt(stringify(input.credential), "connection", input.id) ?? "{}",
      scopesJson: JSON.stringify(input.scopes ?? parseJson(existing?.scopesJson, [])),
      settingsJson: this.encrypt(stringify(input.settings ?? parseJson(
        existing ? this.decrypt(existing.settingsJson, "connection", input.id) : null,
        {},
      )), "connection", input.id) ?? "{}",
      state: input.state ?? existing?.state ?? "active", lastSyncAt: input.lastSyncAt ?? existing?.lastSyncAt ?? null,
      lastError: this.encrypt(input.lastError, "connection", input.id), processingBoundary: "local_only", updatedAt: now,
    };
    const [row] = existing
      ? await this.db.update(proactiveExternalConnections).set(values).where(eq(proactiveExternalConnections.id, input.id)).returning()
      : await this.db.insert(proactiveExternalConnections).values({id: input.id, createdAt: now, ...values}).returning();
    if (!row) throw new Error("failed to upsert proactive connection");
    return this.connectionModel(row);
  }

  async listConnections(tenant: LocalContext, provider?: string, limit?: number): Promise<IntelligenceConnection[]> {
    const conditions = [];
    if (provider) conditions.push(eq(proactiveExternalConnections.provider, provider));
    const rows = await this.db.select().from(proactiveExternalConnections).where(and(...conditions))
      .orderBy(asc(proactiveExternalConnections.provider)).limit(limitOf(limit));
    return rows.map((row) => this.connectionModel(row));
  }

  async getConnectionSecret(tenant: LocalContext, id: string): Promise<IntelligenceConnectionSecret | null> {
    const [row] = await this.db.select().from(proactiveExternalConnections).where(eq(proactiveExternalConnections.id, id)).limit(1);
    return row ? {...this.connectionModel(row), credential: parseJson(this.decrypt(row.credentialJson, "connection", row.id), {})} : null;
  }

  async listActiveConnectionSecrets(provider?: string, limit?: number): Promise<IntelligenceConnectionSecret[]> {
    const conditions = [eq(proactiveExternalConnections.state, "active")];
    if (provider) conditions.push(eq(proactiveExternalConnections.provider, provider));
    const rows = await this.db.select().from(proactiveExternalConnections).where(and(...conditions)).limit(limitOf(limit));
    return rows.map((row) => ({...this.connectionModel(row), credential: parseJson(this.decrypt(row.credentialJson, "connection", row.id), {})}));
  }

  async updateConnectionState(tenant: LocalContext, id: string, state: string, patch: {lastSyncAt?: string | null; lastError?: string | null} = {}) {
    const [row] = await this.db.update(proactiveExternalConnections).set({
      state, lastSyncAt: patch.lastSyncAt, lastError: this.encrypt(patch.lastError, "connection", id), updatedAt: new Date().toISOString(),
    }).where(and(eq(proactiveExternalConnections.id, id), )).returning();
    return row ? this.connectionModel(row) : null;
  }

  async deleteConnection(tenant: LocalContext, id: string): Promise<boolean> {
    const owned = and(
      eq(proactiveExternalConnections.id, id),
    );
    const [connection] = await this.db.select({id: proactiveExternalConnections.id})
      .from(proactiveExternalConnections).where(owned).limit(1);
    if (!connection) return false;
    // Credentials disappear first; cache cleanup can be retried without preserving an active secret.
    await this.db.delete(proactiveExternalConnections).where(owned);
    await this.db.delete(proactiveHomeEntities).where(and(
      eq(proactiveHomeEntities.connectionId, id),
    ));
    await this.db.delete(proactiveHealthSamples).where(and(
      eq(proactiveHealthSamples.connectionId, id),
    ));
    return true;
  }

  async upsertHomeEntity(tenant: LocalContext, input: {
    id: string; connectionId: string; entityId: string; domain: string; displayName?: string | null;
    deviceClass?: string | null; allowedOps?: string[]; state?: unknown; enabled?: boolean; sensitive?: boolean; lastSeenAt?: string;
  }) {
    const now = new Date().toISOString();
    const [existing] = await this.db.select().from(proactiveHomeEntities).where(and(
      eq(proactiveHomeEntities.connectionId, input.connectionId), eq(proactiveHomeEntities.entityId, input.entityId),
    )).limit(1);
    const id = existing?.id ?? input.id;
    const values = {
      domain: input.domain, displayName: this.encrypt(input.displayName, "home-entity", id), deviceClass: input.deviceClass ?? null,
      allowedOpsJson: JSON.stringify(input.allowedOps ?? parseJson(existing?.allowedOpsJson, [])),
      stateJson: this.encrypt(stringify(input.state ?? parseJson(
        existing ? this.decrypt(existing.stateJson, "home-entity", id) : null,
        {},
      )), "home-entity", id) ?? "{}",
      enabled: input.enabled ?? bool(existing?.enabled), sensitive: input.sensitive ?? bool(existing?.sensitive),
      lastSeenAt: input.lastSeenAt ?? now, updatedAt: now,
    };
    const [row] = existing
      ? await this.db.update(proactiveHomeEntities).set(values).where(eq(proactiveHomeEntities.id, id)).returning()
      : await this.db.insert(proactiveHomeEntities).values({id, connectionId: input.connectionId, entityId: input.entityId, createdAt: now, ...values}).returning();
    return row ? this.homeEntityModel(row) : null;
  }

  async listHomeEntities(tenant: LocalContext, connectionId?: string, enabled?: boolean, limit?: number) {
    const conditions = [];
    if (connectionId) conditions.push(eq(proactiveHomeEntities.connectionId, connectionId));
    if (enabled !== undefined) conditions.push(eq(proactiveHomeEntities.enabled, enabled));
    const rows = await this.db.select().from(proactiveHomeEntities).where(and(...conditions))
      .orderBy(asc(proactiveHomeEntities.entityId)).limit(limitOf(limit));
    return rows.map((row) => this.homeEntityModel(row));
  }

  async getHomeEntity(tenant: LocalContext, connectionId: string, entityId: string) {
    const [row] = await this.db.select().from(proactiveHomeEntities).where(and(
      eq(proactiveHomeEntities.connectionId, connectionId),
      eq(proactiveHomeEntities.entityId, entityId),
    )).limit(1);
    return row ? this.homeEntityModel(row) : null;
  }

  async upsertHealthSample(tenant: LocalContext, input: {
    id: string; connectionId: string; metric: string; localDate: string; value: number; unit: string;
    sensitivity?: string; source?: string; metadata?: unknown; observedAt?: string;
  }) {
    const now = new Date().toISOString();
    const [existing] = await this.db.select().from(proactiveHealthSamples).where(and(
      eq(proactiveHealthSamples.connectionId, input.connectionId), eq(proactiveHealthSamples.metric, input.metric),
      eq(proactiveHealthSamples.localDate, input.localDate),
    )).limit(1);
    const id = existing?.id ?? input.id;
    const values = {
      value: Math.round(input.value), unit: input.unit, sensitivity: input.sensitivity ?? "low",
      source: input.source ?? "xiaomi_health", metadataJson: this.encrypt(stringify(input.metadata), "health-sample", id) ?? "{}",
      observedAt: input.observedAt ?? now, processingBoundary: "local_only", updatedAt: now,
    };
    const [row] = existing
      ? await this.db.update(proactiveHealthSamples).set(values).where(eq(proactiveHealthSamples.id, id)).returning()
      : await this.db.insert(proactiveHealthSamples).values({id, connectionId: input.connectionId, metric: input.metric, localDate: input.localDate, createdAt: now, ...values}).returning();
    return row ? this.healthSampleModel(row) : null;
  }

  async listHealthSamples(tenant: LocalContext, options: {connectionId?: string; metric?: string; from?: string; to?: string; limit?: number} = {}) {
    const conditions = [];
    if (options.connectionId) conditions.push(eq(proactiveHealthSamples.connectionId, options.connectionId));
    if (options.metric) conditions.push(eq(proactiveHealthSamples.metric, options.metric));
    if (options.from) conditions.push(gte(proactiveHealthSamples.localDate, options.from));
    if (options.to) conditions.push(lte(proactiveHealthSamples.localDate, options.to));
    const rows = await this.db.select().from(proactiveHealthSamples).where(and(...conditions)).orderBy(desc(proactiveHealthSamples.localDate)).limit(limitOf(options.limit));
    return rows.map((row) => this.healthSampleModel(row));
  }

  async exportSnapshot(tenant: LocalContext): Promise<IntelligenceSnapshot> {
    const [timeline, projects, commitments, relationships, workflows, triggerRules, triggerEvents,
      verifications, conflicts, preparations, attentionStates, driftSignals, scenes, reviews, connections,
      homeEntities, healthSamples] = await Promise.all([
      this.listTimeline(tenant, {limit: MAX_LIMIT}), this.listProjects(tenant, undefined, MAX_LIMIT),
      this.listCommitments(tenant, {limit: MAX_LIMIT}), this.listRelationships(tenant, MAX_LIMIT),
      this.listWorkflows(tenant, undefined, MAX_LIMIT), this.listTriggerRules(tenant, undefined, MAX_LIMIT), this.listTriggerEvents(tenant, MAX_LIMIT),
      this.listActionVerifications(tenant, undefined, MAX_LIMIT), this.listClaimConflicts(tenant, undefined, MAX_LIMIT), this.listPreparations(tenant, undefined, MAX_LIMIT),
      this.listAttentionStates(tenant, MAX_LIMIT), this.listDriftSignals(tenant, undefined, MAX_LIMIT),
      this.listScenes(tenant, MAX_LIMIT), this.listReviews(tenant, MAX_LIMIT), this.listConnections(tenant, undefined, MAX_LIMIT),
      this.listHomeEntities(tenant, undefined, undefined, MAX_LIMIT), this.listHealthSamples(tenant, {limit: MAX_LIMIT}),
    ]);
    return {exportedAt: new Date().toISOString(), timeline, projects, commitments, relationships, workflows,
      triggerRules, triggerEvents, verifications, conflicts, preparations, attentionStates, driftSignals,
      scenes, reviews, connections, homeEntities, healthSamples};
  }

  private timelineModel(row: typeof proactiveTimelineEvents.$inferSelect): IntelligenceTimelineEvent {
    return {id: row.id, revisionId: row.revisionId, sourceGrantId: row.sourceGrantId, sourceKey: row.sourceKey,
      eventType: row.eventType, subjectKey: this.decrypt(row.subjectKey, "timeline", row.id) ?? "",
      title: this.decrypt(row.title, "timeline", row.id) ?? "", summary: this.decrypt(row.summary, "timeline", row.id),
      payload: parseJson(this.decrypt(row.payloadJson, "timeline", row.id), {}), privacyClass: row.privacyClass,
      projectId: row.projectId, relationshipId: row.relationshipId, checksum: row.checksum,
      occurredAt: row.occurredAt, createdAt: row.createdAt};
  }

  private projectModel(row: typeof proactiveProjects.$inferSelect): IntelligenceProject {
    return {id: row.id, revisionId: row.revisionId, title: this.decrypt(row.title, "project", row.id) ?? "",
      objective: this.decrypt(row.objective, "project", row.id), description: this.decrypt(row.description, "project", row.id),
      status: row.status, priority: row.priority, confidence: row.confidence, dueAt: row.dueAt,
      lastActivityAt: row.lastActivityAt, sourceTimelineIds: parseJson(row.sourceTimelineIdsJson, []),
      createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private relationshipModel(row: typeof proactiveRelationships.$inferSelect) {
    return {id: row.id, revisionId: row.revisionId, relationshipType: row.relationshipType,
      displayName: this.decrypt(row.displayName, "relationship", row.id) ?? "", notes: this.decrypt(row.notes, "relationship", row.id),
      state: row.state, confidence: row.confidence, lastInteractionAt: row.lastInteractionAt,
      sourceGrantIds: parseJson(row.sourceGrantIdsJson, []), createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private commitmentModel(row: typeof proactiveCommitments.$inferSelect): IntelligenceCommitment {
    return {id: row.id, revisionId: row.revisionId, projectId: row.projectId, relationshipId: row.relationshipId,
      content: this.decrypt(row.content, "commitment", row.id) ?? "", status: row.status, importance: row.importance,
      dueAt: row.dueAt, sourceTimelineId: row.sourceTimelineId, createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private workflowModel(row: typeof proactiveWorkflowTemplates.$inferSelect): IntelligenceWorkflow {
    return {id: row.id, revisionId: row.revisionId, name: this.decrypt(row.name, "workflow", row.id) ?? "",
      description: this.decrypt(row.description, "workflow", row.id), state: row.state,
      trigger: parseJson(this.decrypt(row.triggerJson, "workflow", row.id), {}),
      steps: parseJson(this.decrypt(row.stepsJson, "workflow", row.id), []), evidenceCount: row.evidenceCount,
      successCount: row.successCount, failureCount: row.failureCount, lastObservedAt: row.lastObservedAt,
      createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private triggerRuleModel(row: typeof proactiveTriggerRules.$inferSelect): IntelligenceTriggerRule {
    return {id: row.id, revisionId: row.revisionId, pluginId: row.pluginId,
      name: this.decrypt(row.name, "trigger-rule", row.id) ?? "",
      triggerType: row.triggerType, condition: parseJson(this.decrypt(row.conditionJson, "trigger-rule", row.id), {}),
      action: parseJson(this.decrypt(row.actionJson, "trigger-rule", row.id), {}), enabled: bool(row.enabled),
      cooldownSeconds: row.cooldownSeconds, quietHours: parseJson(row.quietHoursJson, {}), lastTriggeredAt: row.lastTriggeredAt,
      createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private triggerEventModel(row: typeof proactiveTriggerEvents.$inferSelect) {
    return {id: row.id, revisionId: row.revisionId, ruleId: row.ruleId, triggerType: row.triggerType,
      cause: parseJson(this.decrypt(row.causeJson, "trigger-event", row.id), {}), decision: row.decision,
      reason: this.decrypt(row.reason, "trigger-event", row.id), actionId: row.actionId, occurredAt: row.occurredAt};
  }

  private verificationModel(row: typeof proactiveActionVerifications.$inferSelect) {
    return {id: row.id, actionId: row.actionId, expected: parseJson(this.decrypt(row.expectedJson, "verification", row.id), {}),
      observed: parseJson(this.decrypt(row.observedJson, "verification", row.id), null), status: row.status,
      attemptCount: row.attemptCount, verifiedAt: row.verifiedAt, error: this.decrypt(row.error, "verification", row.id),
      createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private conflictModel(row: typeof proactiveClaimConflicts.$inferSelect) {
    return {id: row.id, revisionId: row.revisionId, primaryClaimId: row.primaryClaimId,
      conflictingClaimId: row.conflictingClaimId, reason: this.decrypt(row.reason, "claim-conflict", row.id) ?? "",
      status: row.status, resolution: this.decrypt(row.resolution, "claim-conflict", row.id), resolvedAt: row.resolvedAt,
      createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private preparationModel(row: typeof proactivePreparationBundles.$inferSelect) {
    return {id: row.id, revisionId: row.revisionId, projectId: row.projectId, commitmentId: row.commitmentId,
      title: this.decrypt(row.title, "preparation", row.id) ?? "", bundle: parseJson(this.decrypt(row.bundleJson, "preparation", row.id), {}),
      status: row.status, availableAt: row.availableAt, expiresAt: row.expiresAt, createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private attentionModel(row: typeof proactiveAttentionStates.$inferSelect) {
    return {id: row.id, revisionId: row.revisionId, windowStart: row.windowStart, windowEnd: row.windowEnd,
      focusScore: row.focusScore, fatigueScore: row.fatigueScore, contextSwitches: row.contextSwitches,
      errorSignals: row.errorSignals, recommendation: this.decrypt(row.recommendation, "attention", row.id),
      evidence: parseJson(this.decrypt(row.evidenceJson, "attention", row.id), []), createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private driftModel(row: typeof proactiveDriftSignals.$inferSelect) {
    return {id: row.id, revisionId: row.revisionId, signalType: row.signalType, projectId: row.projectId,
      expected: parseJson(this.decrypt(row.expectedJson, "drift", row.id), {}), actual: parseJson(this.decrypt(row.actualJson, "drift", row.id), {}),
      severity: row.severity, state: row.state, explanation: this.decrypt(row.explanation, "drift", row.id),
      detectedAt: row.detectedAt, createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private sceneModel(row: typeof proactiveSceneSnapshots.$inferSelect) {
    return {id: row.id, revisionId: row.revisionId, sceneType: row.sceneType, applicationId: row.applicationId,
      payload: parseJson(this.decrypt(row.payloadJson, "scene", row.id), {}), checksum: row.checksum,
      capturedAt: row.capturedAt, createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private reviewModel(row: typeof proactiveReviewReports.$inferSelect) {
    return {id: row.id, revisionId: row.revisionId, periodType: row.periodType, periodStart: row.periodStart, periodEnd: row.periodEnd,
      summary: this.decrypt(row.summary, "review", row.id) ?? "", metrics: parseJson(this.decrypt(row.metricsJson, "review", row.id), {}),
      recommendations: parseJson(this.decrypt(row.recommendationsJson, "review", row.id), []), createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private connectionModel(row: typeof proactiveExternalConnections.$inferSelect): IntelligenceConnection {
    const credential = this.decrypt(row.credentialJson, "connection", row.id);
    return {id: row.id, revisionId: row.revisionId,
      provider: row.provider, displayName: this.decrypt(row.displayName, "connection", row.id) ?? "", endpoint: row.endpoint,
      authType: row.authType, scopes: parseJson(row.scopesJson, []), settings: parseJson(this.decrypt(row.settingsJson, "connection", row.id), {}),
      state: row.state, lastSyncAt: row.lastSyncAt, lastError: this.decrypt(row.lastError, "connection", row.id),
      hasCredential: Boolean(credential && credential !== "{}"), createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private homeEntityModel(row: typeof proactiveHomeEntities.$inferSelect) {
    return {id: row.id, connectionId: row.connectionId, entityId: row.entityId, domain: row.domain,
      displayName: this.decrypt(row.displayName, "home-entity", row.id), deviceClass: row.deviceClass,
      allowedOps: parseJson<string[]>(row.allowedOpsJson, []), state: parseJson<Record<string, unknown>>(this.decrypt(row.stateJson, "home-entity", row.id), {}),
      enabled: bool(row.enabled), sensitive: bool(row.sensitive), lastSeenAt: row.lastSeenAt,
      createdAt: row.createdAt, updatedAt: row.updatedAt};
  }

  private healthSampleModel(row: typeof proactiveHealthSamples.$inferSelect) {
    return {id: row.id, connectionId: row.connectionId, metric: row.metric, localDate: row.localDate,
      value: row.value, unit: row.unit, sensitivity: row.sensitivity, source: row.source,
      metadata: parseJson(this.decrypt(row.metadataJson, "health-sample", row.id), {}), observedAt: row.observedAt,
      createdAt: row.createdAt, updatedAt: row.updatedAt};
  }
}
