/** CAP-033/034/035 local proactive intelligence repository. */
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
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
} from "../../schema/index.js";
import { assertTenantContext, type TenantContext } from "../../tenant.js";

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
  workspaceId: string;
  subjectUserId: string;
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
    tenant: TenantContext,
    input: Omit<IntelligenceTimelineEvent, "createdAt">,
  ): Promise<IntelligenceTimelineEvent> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [existing] = await this.db
      .select()
      .from(proactiveTimelineEvents)
      .where(and(
        eq(proactiveTimelineEvents.workspaceId, tenant.workspaceId),
        eq(proactiveTimelineEvents.subjectUserId, tenant.subjectUserId),
        eq(proactiveTimelineEvents.checksum, input.checksum),
      ))
      .limit(1);
    if (existing) return this.timelineModel(existing);
    const [created] = await this.db.insert(proactiveTimelineEvents).values({
      id: input.id,
      workspaceId: tenant.workspaceId,
      subjectUserId: tenant.subjectUserId,
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
    }).returning();
    if (!created) throw new Error("failed to create proactive timeline event");
    return this.timelineModel(created);
  }

  async listTimeline(
    tenant: TenantContext,
    options: { from?: string; to?: string; sourceKey?: string; projectId?: string; limit?: number } = {},
  ): Promise<IntelligenceTimelineEvent[]> {
    assertTenantContext(tenant);
    const conditions = [
      eq(proactiveTimelineEvents.workspaceId, tenant.workspaceId),
      eq(proactiveTimelineEvents.subjectUserId, tenant.subjectUserId),
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
    tenant: TenantContext,
    input: Omit<IntelligenceProject, "createdAt" | "updatedAt">,
  ): Promise<IntelligenceProject> {
    assertTenantContext(tenant);
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
      eq(proactiveProjects.workspaceId, tenant.workspaceId),
      eq(proactiveProjects.subjectUserId, tenant.subjectUserId),
    )).limit(1);
    const [row] = existing
      ? await this.db.update(proactiveProjects).set(values).where(eq(proactiveProjects.id, input.id)).returning()
      : await this.db.insert(proactiveProjects).values({
        id: input.id,
        workspaceId: tenant.workspaceId,
        subjectUserId: tenant.subjectUserId,
        createdAt: now,
        ...values,
      }).returning();
    if (!row) throw new Error("failed to upsert proactive project");
    return this.projectModel(row);
  }

  async listProjects(tenant: TenantContext, status?: string, limit?: number): Promise<IntelligenceProject[]> {
    assertTenantContext(tenant);
    const conditions = [eq(proactiveProjects.workspaceId, tenant.workspaceId), eq(proactiveProjects.subjectUserId, tenant.subjectUserId)];
    if (status) conditions.push(eq(proactiveProjects.status, status));
    const rows = await this.db.select().from(proactiveProjects).where(and(...conditions))
      .orderBy(desc(proactiveProjects.lastActivityAt)).limit(limitOf(limit));
    return rows.map((row) => this.projectModel(row));
  }

  async upsertRelationship(tenant: TenantContext, input: {
    id: string; revisionId: string; relationshipType: string; displayName: string; notes?: string | null;
    state?: string; confidence?: number; lastInteractionAt?: string | null; sourceGrantIds?: string[];
  }) {
    assertTenantContext(tenant);
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
    const [existing] = await this.db.select().from(proactiveRelationships).where(and(
      eq(proactiveRelationships.id, input.id), eq(proactiveRelationships.workspaceId, tenant.workspaceId),
      eq(proactiveRelationships.subjectUserId, tenant.subjectUserId),
    )).limit(1);
    const [row] = existing
      ? await this.db.update(proactiveRelationships).set(values).where(eq(proactiveRelationships.id, input.id)).returning()
      : await this.db.insert(proactiveRelationships).values({id: input.id, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId, createdAt: now, ...values}).returning();
    if (!row) throw new Error("failed to upsert proactive relationship");
    return this.relationshipModel(row);
  }

  async listRelationships(tenant: TenantContext, limit?: number) {
    assertTenantContext(tenant);
    const rows = await this.db.select().from(proactiveRelationships).where(and(
      eq(proactiveRelationships.workspaceId, tenant.workspaceId),
      eq(proactiveRelationships.subjectUserId, tenant.subjectUserId),
    )).orderBy(desc(proactiveRelationships.lastInteractionAt)).limit(limitOf(limit));
    return rows.map((row) => this.relationshipModel(row));
  }

  async createCommitment(tenant: TenantContext, input: Omit<IntelligenceCommitment, "createdAt" | "updatedAt">): Promise<IntelligenceCommitment> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [row] = await this.db.insert(proactiveCommitments).values({
      id: input.id, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId,
      revisionId: input.revisionId, projectId: input.projectId ?? null, relationshipId: input.relationshipId ?? null,
      content: this.encrypt(input.content, "commitment", input.id) ?? "", status: input.status,
      importance: input.importance, dueAt: input.dueAt ?? null, sourceTimelineId: input.sourceTimelineId ?? null,
      processingBoundary: "local_only", createdAt: now, updatedAt: now,
    }).returning();
    if (!row) throw new Error("failed to create proactive commitment");
    return this.commitmentModel(row);
  }

  async updateCommitmentStatus(tenant: TenantContext, id: string, status: string) {
    assertTenantContext(tenant);
    const [row] = await this.db.update(proactiveCommitments).set({status, updatedAt: new Date().toISOString()}).where(and(
      eq(proactiveCommitments.id, id), eq(proactiveCommitments.workspaceId, tenant.workspaceId),
      eq(proactiveCommitments.subjectUserId, tenant.subjectUserId),
    )).returning();
    return row ? this.commitmentModel(row) : null;
  }

  async listCommitments(tenant: TenantContext, options: { status?: string; dueBefore?: string; limit?: number } = {}) {
    assertTenantContext(tenant);
    const conditions = [eq(proactiveCommitments.workspaceId, tenant.workspaceId), eq(proactiveCommitments.subjectUserId, tenant.subjectUserId)];
    if (options.status) conditions.push(eq(proactiveCommitments.status, options.status));
    if (options.dueBefore) conditions.push(lte(proactiveCommitments.dueAt, options.dueBefore));
    const rows = await this.db.select().from(proactiveCommitments).where(and(...conditions))
      .orderBy(asc(proactiveCommitments.dueAt)).limit(limitOf(options.limit));
    return rows.map((row) => this.commitmentModel(row));
  }

  async upsertWorkflow(tenant: TenantContext, input: Omit<IntelligenceWorkflow, "createdAt" | "updatedAt">): Promise<IntelligenceWorkflow> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const values = {
      revisionId: input.revisionId, name: this.encrypt(input.name, "workflow", input.id) ?? "",
      description: this.encrypt(input.description, "workflow", input.id), state: input.state,
      triggerJson: this.encrypt(stringify(input.trigger), "workflow", input.id) ?? "{}",
      stepsJson: this.encrypt(JSON.stringify(input.steps), "workflow", input.id) ?? "[]",
      evidenceCount: input.evidenceCount, successCount: input.successCount, failureCount: input.failureCount,
      lastObservedAt: input.lastObservedAt ?? null, processingBoundary: "local_only", updatedAt: now,
    };
    const [existing] = await this.db.select().from(proactiveWorkflowTemplates).where(and(
      eq(proactiveWorkflowTemplates.id, input.id), eq(proactiveWorkflowTemplates.workspaceId, tenant.workspaceId),
      eq(proactiveWorkflowTemplates.subjectUserId, tenant.subjectUserId),
    )).limit(1);
    const [row] = existing
      ? await this.db.update(proactiveWorkflowTemplates).set(values).where(eq(proactiveWorkflowTemplates.id, input.id)).returning()
      : await this.db.insert(proactiveWorkflowTemplates).values({id: input.id, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId, createdAt: now, ...values}).returning();
    if (!row) throw new Error("failed to upsert proactive workflow");
    return this.workflowModel(row);
  }

  async listWorkflows(tenant: TenantContext, state?: string, limit?: number): Promise<IntelligenceWorkflow[]> {
    assertTenantContext(tenant);
    const conditions = [eq(proactiveWorkflowTemplates.workspaceId, tenant.workspaceId), eq(proactiveWorkflowTemplates.subjectUserId, tenant.subjectUserId)];
    if (state) conditions.push(eq(proactiveWorkflowTemplates.state, state));
    const rows = await this.db.select().from(proactiveWorkflowTemplates).where(and(...conditions))
      .orderBy(desc(proactiveWorkflowTemplates.evidenceCount)).limit(limitOf(limit));
    return rows.map((row) => this.workflowModel(row));
  }

  async upsertTriggerRule(tenant: TenantContext, input: Omit<IntelligenceTriggerRule, "createdAt" | "updatedAt">): Promise<IntelligenceTriggerRule> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const values = {
      revisionId: input.revisionId, name: this.encrypt(input.name, "trigger-rule", input.id) ?? "",
      triggerType: input.triggerType, conditionJson: this.encrypt(stringify(input.condition), "trigger-rule", input.id) ?? "{}",
      actionJson: this.encrypt(stringify(input.action), "trigger-rule", input.id) ?? "{}", enabled: input.enabled,
      cooldownSeconds: input.cooldownSeconds, quietHoursJson: JSON.stringify(input.quietHours ?? {}),
      lastTriggeredAt: input.lastTriggeredAt ?? null, processingBoundary: "local_only", updatedAt: now,
    };
    const [existing] = await this.db.select().from(proactiveTriggerRules).where(and(
      eq(proactiveTriggerRules.id, input.id), eq(proactiveTriggerRules.workspaceId, tenant.workspaceId),
      eq(proactiveTriggerRules.subjectUserId, tenant.subjectUserId),
    )).limit(1);
    const [row] = existing
      ? await this.db.update(proactiveTriggerRules).set(values).where(eq(proactiveTriggerRules.id, input.id)).returning()
      : await this.db.insert(proactiveTriggerRules).values({id: input.id, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId, createdAt: now, ...values}).returning();
    if (!row) throw new Error("failed to upsert proactive trigger rule");
    return this.triggerRuleModel(row);
  }

  async listTriggerRules(tenant: TenantContext, enabled?: boolean): Promise<IntelligenceTriggerRule[]> {
    assertTenantContext(tenant);
    const conditions = [eq(proactiveTriggerRules.workspaceId, tenant.workspaceId), eq(proactiveTriggerRules.subjectUserId, tenant.subjectUserId)];
    if (enabled !== undefined) conditions.push(eq(proactiveTriggerRules.enabled, enabled));
    const rows = await this.db.select().from(proactiveTriggerRules).where(and(...conditions)).orderBy(asc(proactiveTriggerRules.name));
    return rows.map((row) => this.triggerRuleModel(row));
  }

  async recordTriggerEvent(tenant: TenantContext, input: {
    id: string; revisionId: string; ruleId?: string | null; triggerType: string; cause?: unknown;
    decision: string; reason?: string | null; actionId?: string | null; occurredAt?: string;
  }) {
    assertTenantContext(tenant);
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    const [row] = await this.db.insert(proactiveTriggerEvents).values({
      id: input.id, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId,
      revisionId: input.revisionId, ruleId: input.ruleId ?? null, triggerType: input.triggerType,
      causeJson: this.encrypt(stringify(input.cause), "trigger-event", input.id) ?? "{}", decision: input.decision,
      reason: this.encrypt(input.reason, "trigger-event", input.id), actionId: input.actionId ?? null,
      occurredAt, processingBoundary: "local_only", createdAt: occurredAt,
    }).returning();
    return row ? this.triggerEventModel(row) : null;
  }

  async listTriggerEvents(tenant: TenantContext, limit?: number) {
    assertTenantContext(tenant);
    const rows = await this.db.select().from(proactiveTriggerEvents).where(and(
      eq(proactiveTriggerEvents.workspaceId, tenant.workspaceId), eq(proactiveTriggerEvents.subjectUserId, tenant.subjectUserId),
    )).orderBy(desc(proactiveTriggerEvents.occurredAt)).limit(limitOf(limit));
    return rows.map((row) => this.triggerEventModel(row));
  }

  async upsertActionVerification(tenant: TenantContext, input: {
    id: string; actionId: string; expected?: unknown; observed?: unknown; status: string;
    attemptCount?: number; verifiedAt?: string | null; error?: string | null;
  }) {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const values = {
      expectedJson: this.encrypt(stringify(input.expected), "verification", input.id) ?? "{}",
      observedJson: input.observed === undefined ? null : this.encrypt(stringify(input.observed), "verification", input.id),
      status: input.status, attemptCount: input.attemptCount ?? 0, verifiedAt: input.verifiedAt ?? null,
      error: this.encrypt(input.error, "verification", input.id), processingBoundary: "local_only", updatedAt: now,
    };
    const [existing] = await this.db.select().from(proactiveActionVerifications).where(and(
      eq(proactiveActionVerifications.actionId, input.actionId), eq(proactiveActionVerifications.workspaceId, tenant.workspaceId),
      eq(proactiveActionVerifications.subjectUserId, tenant.subjectUserId),
    )).limit(1);
    const id = existing?.id ?? input.id;
    const encryptedValues = id === input.id ? values : {
      ...values,
      expectedJson: this.encrypt(stringify(input.expected), "verification", id) ?? "{}",
      observedJson: input.observed === undefined ? null : this.encrypt(stringify(input.observed), "verification", id),
      error: this.encrypt(input.error, "verification", id),
    };
    const [row] = existing
      ? await this.db.update(proactiveActionVerifications).set(encryptedValues).where(eq(proactiveActionVerifications.id, id)).returning()
      : await this.db.insert(proactiveActionVerifications).values({id, actionId: input.actionId, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId, createdAt: now, ...encryptedValues}).returning();
    return row ? this.verificationModel(row) : null;
  }

  async listActionVerifications(tenant: TenantContext, status?: string) {
    assertTenantContext(tenant);
    const conditions = [eq(proactiveActionVerifications.workspaceId, tenant.workspaceId), eq(proactiveActionVerifications.subjectUserId, tenant.subjectUserId)];
    if (status) conditions.push(eq(proactiveActionVerifications.status, status));
    const rows = await this.db.select().from(proactiveActionVerifications).where(and(...conditions)).orderBy(desc(proactiveActionVerifications.updatedAt));
    return rows.map((row) => this.verificationModel(row));
  }

  async createClaimConflict(tenant: TenantContext, input: {
    id: string; revisionId: string; primaryClaimId: string; conflictingClaimId: string; reason: string;
  }) {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [existing] = await this.db.select().from(proactiveClaimConflicts).where(and(
      eq(proactiveClaimConflicts.primaryClaimId, input.primaryClaimId),
      eq(proactiveClaimConflicts.conflictingClaimId, input.conflictingClaimId),
      eq(proactiveClaimConflicts.workspaceId, tenant.workspaceId),
      eq(proactiveClaimConflicts.subjectUserId, tenant.subjectUserId),
    )).limit(1);
    if (existing) return this.conflictModel(existing);
    const [row] = await this.db.insert(proactiveClaimConflicts).values({
      id: input.id, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId,
      revisionId: input.revisionId, primaryClaimId: input.primaryClaimId, conflictingClaimId: input.conflictingClaimId,
      reason: this.encrypt(input.reason, "claim-conflict", input.id) ?? "", status: "open", resolution: null,
      resolvedAt: null, processingBoundary: "local_only", createdAt: now, updatedAt: now,
    }).returning();
    return row ? this.conflictModel(row) : null;
  }

  async resolveClaimConflict(tenant: TenantContext, id: string, resolution: string) {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [row] = await this.db.update(proactiveClaimConflicts).set({
      status: "resolved", resolution: this.encrypt(resolution, "claim-conflict", id), resolvedAt: now, updatedAt: now,
    }).where(and(eq(proactiveClaimConflicts.id, id), eq(proactiveClaimConflicts.workspaceId, tenant.workspaceId), eq(proactiveClaimConflicts.subjectUserId, tenant.subjectUserId))).returning();
    return row ? this.conflictModel(row) : null;
  }

  async listClaimConflicts(tenant: TenantContext, status?: string) {
    assertTenantContext(tenant);
    const conditions = [eq(proactiveClaimConflicts.workspaceId, tenant.workspaceId), eq(proactiveClaimConflicts.subjectUserId, tenant.subjectUserId)];
    if (status) conditions.push(eq(proactiveClaimConflicts.status, status));
    const rows = await this.db.select().from(proactiveClaimConflicts).where(and(...conditions)).orderBy(desc(proactiveClaimConflicts.createdAt));
    return rows.map((row) => this.conflictModel(row));
  }

  async createPreparation(tenant: TenantContext, input: {
    id: string; revisionId: string; projectId?: string | null; commitmentId?: string | null;
    title: string; bundle: unknown; status?: string; availableAt?: string; expiresAt?: string | null;
  }) {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [row] = await this.db.insert(proactivePreparationBundles).values({
      id: input.id, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId, revisionId: input.revisionId,
      projectId: input.projectId ?? null, commitmentId: input.commitmentId ?? null,
      title: this.encrypt(input.title, "preparation", input.id) ?? "",
      bundleJson: this.encrypt(stringify(input.bundle), "preparation", input.id) ?? "{}", status: input.status ?? "ready",
      availableAt: input.availableAt ?? now, expiresAt: input.expiresAt ?? null, processingBoundary: "local_only",
      createdAt: now, updatedAt: now,
    }).returning();
    return row ? this.preparationModel(row) : null;
  }

  async listPreparations(tenant: TenantContext, status?: string, limit?: number) {
    assertTenantContext(tenant);
    const conditions = [eq(proactivePreparationBundles.workspaceId, tenant.workspaceId), eq(proactivePreparationBundles.subjectUserId, tenant.subjectUserId)];
    if (status) conditions.push(eq(proactivePreparationBundles.status, status));
    const rows = await this.db.select().from(proactivePreparationBundles).where(and(...conditions)).orderBy(desc(proactivePreparationBundles.availableAt)).limit(limitOf(limit));
    return rows.map((row) => this.preparationModel(row));
  }

  async createAttentionState(tenant: TenantContext, input: {
    id: string; revisionId: string; windowStart: string; windowEnd: string; focusScore: number; fatigueScore: number;
    contextSwitches?: number; errorSignals?: number; recommendation?: string | null; evidence?: unknown[];
  }) {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [row] = await this.db.insert(proactiveAttentionStates).values({
      id: input.id, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId, revisionId: input.revisionId,
      windowStart: input.windowStart, windowEnd: input.windowEnd, focusScore: input.focusScore, fatigueScore: input.fatigueScore,
      contextSwitches: input.contextSwitches ?? 0, errorSignals: input.errorSignals ?? 0,
      recommendation: this.encrypt(input.recommendation, "attention", input.id),
      evidenceJson: this.encrypt(JSON.stringify(input.evidence ?? []), "attention", input.id) ?? "[]",
      processingBoundary: "local_only", createdAt: now, updatedAt: now,
    }).returning();
    return row ? this.attentionModel(row) : null;
  }

  async listAttentionStates(tenant: TenantContext, limit?: number) {
    assertTenantContext(tenant);
    const rows = await this.db.select().from(proactiveAttentionStates).where(and(
      eq(proactiveAttentionStates.workspaceId, tenant.workspaceId), eq(proactiveAttentionStates.subjectUserId, tenant.subjectUserId),
    )).orderBy(desc(proactiveAttentionStates.windowEnd)).limit(limitOf(limit));
    return rows.map((row) => this.attentionModel(row));
  }

  async createDriftSignal(tenant: TenantContext, input: {
    id: string; revisionId: string; signalType: string; projectId?: string | null; expected?: unknown; actual?: unknown;
    severity: number; state?: string; explanation?: string | null; detectedAt?: string;
  }) {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [row] = await this.db.insert(proactiveDriftSignals).values({
      id: input.id, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId, revisionId: input.revisionId,
      signalType: input.signalType, projectId: input.projectId ?? null,
      expectedJson: this.encrypt(stringify(input.expected), "drift", input.id) ?? "{}",
      actualJson: this.encrypt(stringify(input.actual), "drift", input.id) ?? "{}",
      severity: input.severity, state: input.state ?? "open", explanation: this.encrypt(input.explanation, "drift", input.id),
      detectedAt: input.detectedAt ?? now, processingBoundary: "local_only", createdAt: now, updatedAt: now,
    }).returning();
    return row ? this.driftModel(row) : null;
  }

  async listDriftSignals(tenant: TenantContext, state?: string, limit?: number) {
    assertTenantContext(tenant);
    const conditions = [eq(proactiveDriftSignals.workspaceId, tenant.workspaceId), eq(proactiveDriftSignals.subjectUserId, tenant.subjectUserId)];
    if (state) conditions.push(eq(proactiveDriftSignals.state, state));
    const rows = await this.db.select().from(proactiveDriftSignals).where(and(...conditions)).orderBy(desc(proactiveDriftSignals.detectedAt)).limit(limitOf(limit));
    return rows.map((row) => this.driftModel(row));
  }

  async createScene(tenant: TenantContext, input: {
    id: string; revisionId: string; sceneType: string; applicationId?: string | null; payload?: unknown;
    checksum: string; capturedAt?: string;
  }) {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [existing] = await this.db.select().from(proactiveSceneSnapshots).where(and(
      eq(proactiveSceneSnapshots.workspaceId, tenant.workspaceId), eq(proactiveSceneSnapshots.subjectUserId, tenant.subjectUserId),
      eq(proactiveSceneSnapshots.checksum, input.checksum),
    )).limit(1);
    if (existing) return this.sceneModel(existing);
    const [row] = await this.db.insert(proactiveSceneSnapshots).values({
      id: input.id, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId, revisionId: input.revisionId,
      sceneType: input.sceneType, applicationId: input.applicationId ?? null,
      payloadJson: this.encrypt(stringify(input.payload), "scene", input.id) ?? "{}", checksum: input.checksum,
      capturedAt: input.capturedAt ?? now, processingBoundary: "local_only", createdAt: now, updatedAt: now,
    }).returning();
    return row ? this.sceneModel(row) : null;
  }

  async listScenes(tenant: TenantContext, limit?: number) {
    assertTenantContext(tenant);
    const rows = await this.db.select().from(proactiveSceneSnapshots).where(and(
      eq(proactiveSceneSnapshots.workspaceId, tenant.workspaceId), eq(proactiveSceneSnapshots.subjectUserId, tenant.subjectUserId),
    )).orderBy(desc(proactiveSceneSnapshots.capturedAt)).limit(limitOf(limit));
    return rows.map((row) => this.sceneModel(row));
  }

  async upsertReview(tenant: TenantContext, input: {
    id: string; revisionId: string; periodType: string; periodStart: string; periodEnd: string;
    summary: string; metrics?: unknown; recommendations?: unknown[];
  }) {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [existing] = await this.db.select().from(proactiveReviewReports).where(and(
      eq(proactiveReviewReports.workspaceId, tenant.workspaceId), eq(proactiveReviewReports.subjectUserId, tenant.subjectUserId),
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
      : await this.db.insert(proactiveReviewReports).values({id, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId, periodType: input.periodType, periodStart: input.periodStart, periodEnd: input.periodEnd, createdAt: now, ...values}).returning();
    return row ? this.reviewModel(row) : null;
  }

  async listReviews(tenant: TenantContext, limit?: number) {
    assertTenantContext(tenant);
    const rows = await this.db.select().from(proactiveReviewReports).where(and(
      eq(proactiveReviewReports.workspaceId, tenant.workspaceId), eq(proactiveReviewReports.subjectUserId, tenant.subjectUserId),
    )).orderBy(desc(proactiveReviewReports.periodEnd)).limit(limitOf(limit));
    return rows.map((row) => this.reviewModel(row));
  }

  async upsertConnection(tenant: TenantContext, input: {
    id: string; revisionId: string; provider: string; displayName: string; endpoint?: string | null;
    authType: string; credential?: Record<string, unknown>; scopes?: string[]; settings?: Record<string, unknown>;
    state?: string; lastSyncAt?: string | null; lastError?: string | null;
  }): Promise<IntelligenceConnection> {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [existing] = await this.db.select().from(proactiveExternalConnections).where(and(
      eq(proactiveExternalConnections.id, input.id), eq(proactiveExternalConnections.workspaceId, tenant.workspaceId),
      eq(proactiveExternalConnections.subjectUserId, tenant.subjectUserId),
    )).limit(1);
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
      : await this.db.insert(proactiveExternalConnections).values({id: input.id, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId, createdAt: now, ...values}).returning();
    if (!row) throw new Error("failed to upsert proactive connection");
    return this.connectionModel(row);
  }

  async listConnections(tenant: TenantContext, provider?: string): Promise<IntelligenceConnection[]> {
    assertTenantContext(tenant);
    const conditions = [eq(proactiveExternalConnections.workspaceId, tenant.workspaceId), eq(proactiveExternalConnections.subjectUserId, tenant.subjectUserId)];
    if (provider) conditions.push(eq(proactiveExternalConnections.provider, provider));
    const rows = await this.db.select().from(proactiveExternalConnections).where(and(...conditions)).orderBy(asc(proactiveExternalConnections.provider));
    return rows.map((row) => this.connectionModel(row));
  }

  async getConnectionSecret(tenant: TenantContext, id: string): Promise<IntelligenceConnectionSecret | null> {
    assertTenantContext(tenant);
    const [row] = await this.db.select().from(proactiveExternalConnections).where(and(
      eq(proactiveExternalConnections.id, id), eq(proactiveExternalConnections.workspaceId, tenant.workspaceId),
      eq(proactiveExternalConnections.subjectUserId, tenant.subjectUserId),
    )).limit(1);
    return row ? {...this.connectionModel(row), credential: parseJson(this.decrypt(row.credentialJson, "connection", row.id), {})} : null;
  }

  async listActiveConnectionSecrets(provider?: string): Promise<IntelligenceConnectionSecret[]> {
    const conditions = [eq(proactiveExternalConnections.state, "active")];
    if (provider) conditions.push(eq(proactiveExternalConnections.provider, provider));
    const rows = await this.db.select().from(proactiveExternalConnections).where(and(...conditions));
    return rows.map((row) => ({...this.connectionModel(row), credential: parseJson(this.decrypt(row.credentialJson, "connection", row.id), {})}));
  }

  async updateConnectionState(tenant: TenantContext, id: string, state: string, patch: {lastSyncAt?: string | null; lastError?: string | null} = {}) {
    assertTenantContext(tenant);
    const [row] = await this.db.update(proactiveExternalConnections).set({
      state, lastSyncAt: patch.lastSyncAt, lastError: this.encrypt(patch.lastError, "connection", id), updatedAt: new Date().toISOString(),
    }).where(and(eq(proactiveExternalConnections.id, id), eq(proactiveExternalConnections.workspaceId, tenant.workspaceId), eq(proactiveExternalConnections.subjectUserId, tenant.subjectUserId))).returning();
    return row ? this.connectionModel(row) : null;
  }

  async deleteConnection(tenant: TenantContext, id: string): Promise<boolean> {
    assertTenantContext(tenant);
    const owned = and(
      eq(proactiveExternalConnections.id, id),
      eq(proactiveExternalConnections.workspaceId, tenant.workspaceId),
      eq(proactiveExternalConnections.subjectUserId, tenant.subjectUserId),
    );
    const [connection] = await this.db.select({id: proactiveExternalConnections.id})
      .from(proactiveExternalConnections).where(owned).limit(1);
    if (!connection) return false;
    // Credentials disappear first; cache cleanup can be retried without preserving an active secret.
    await this.db.delete(proactiveExternalConnections).where(owned);
    await this.db.delete(proactiveHomeEntities).where(and(
      eq(proactiveHomeEntities.connectionId, id),
      eq(proactiveHomeEntities.workspaceId, tenant.workspaceId),
      eq(proactiveHomeEntities.subjectUserId, tenant.subjectUserId),
    ));
    await this.db.delete(proactiveHealthSamples).where(and(
      eq(proactiveHealthSamples.connectionId, id),
      eq(proactiveHealthSamples.workspaceId, tenant.workspaceId),
      eq(proactiveHealthSamples.subjectUserId, tenant.subjectUserId),
    ));
    return true;
  }

  async upsertHomeEntity(tenant: TenantContext, input: {
    id: string; connectionId: string; entityId: string; domain: string; displayName?: string | null;
    deviceClass?: string | null; allowedOps?: string[]; state?: unknown; enabled?: boolean; sensitive?: boolean; lastSeenAt?: string;
  }) {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [existing] = await this.db.select().from(proactiveHomeEntities).where(and(
      eq(proactiveHomeEntities.connectionId, input.connectionId), eq(proactiveHomeEntities.entityId, input.entityId),
      eq(proactiveHomeEntities.workspaceId, tenant.workspaceId), eq(proactiveHomeEntities.subjectUserId, tenant.subjectUserId),
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
      : await this.db.insert(proactiveHomeEntities).values({id, connectionId: input.connectionId, entityId: input.entityId, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId, createdAt: now, ...values}).returning();
    return row ? this.homeEntityModel(row) : null;
  }

  async listHomeEntities(tenant: TenantContext, connectionId?: string, enabled?: boolean) {
    assertTenantContext(tenant);
    const conditions = [eq(proactiveHomeEntities.workspaceId, tenant.workspaceId), eq(proactiveHomeEntities.subjectUserId, tenant.subjectUserId)];
    if (connectionId) conditions.push(eq(proactiveHomeEntities.connectionId, connectionId));
    if (enabled !== undefined) conditions.push(eq(proactiveHomeEntities.enabled, enabled));
    const rows = await this.db.select().from(proactiveHomeEntities).where(and(...conditions)).orderBy(asc(proactiveHomeEntities.entityId));
    return rows.map((row) => this.homeEntityModel(row));
  }

  async getHomeEntity(tenant: TenantContext, connectionId: string, entityId: string) {
    assertTenantContext(tenant);
    const [row] = await this.db.select().from(proactiveHomeEntities).where(and(
      eq(proactiveHomeEntities.connectionId, connectionId),
      eq(proactiveHomeEntities.entityId, entityId),
      eq(proactiveHomeEntities.workspaceId, tenant.workspaceId),
      eq(proactiveHomeEntities.subjectUserId, tenant.subjectUserId),
    )).limit(1);
    return row ? this.homeEntityModel(row) : null;
  }

  async upsertHealthSample(tenant: TenantContext, input: {
    id: string; connectionId: string; metric: string; localDate: string; value: number; unit: string;
    sensitivity?: string; source?: string; metadata?: unknown; observedAt?: string;
  }) {
    assertTenantContext(tenant);
    const now = new Date().toISOString();
    const [existing] = await this.db.select().from(proactiveHealthSamples).where(and(
      eq(proactiveHealthSamples.workspaceId, tenant.workspaceId), eq(proactiveHealthSamples.subjectUserId, tenant.subjectUserId),
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
      : await this.db.insert(proactiveHealthSamples).values({id, connectionId: input.connectionId, metric: input.metric, localDate: input.localDate, workspaceId: tenant.workspaceId, subjectUserId: tenant.subjectUserId, createdAt: now, ...values}).returning();
    return row ? this.healthSampleModel(row) : null;
  }

  async listHealthSamples(tenant: TenantContext, options: {connectionId?: string; metric?: string; from?: string; to?: string; limit?: number} = {}) {
    assertTenantContext(tenant);
    const conditions = [eq(proactiveHealthSamples.workspaceId, tenant.workspaceId), eq(proactiveHealthSamples.subjectUserId, tenant.subjectUserId)];
    if (options.connectionId) conditions.push(eq(proactiveHealthSamples.connectionId, options.connectionId));
    if (options.metric) conditions.push(eq(proactiveHealthSamples.metric, options.metric));
    if (options.from) conditions.push(gte(proactiveHealthSamples.localDate, options.from));
    if (options.to) conditions.push(lte(proactiveHealthSamples.localDate, options.to));
    const rows = await this.db.select().from(proactiveHealthSamples).where(and(...conditions)).orderBy(desc(proactiveHealthSamples.localDate)).limit(limitOf(options.limit));
    return rows.map((row) => this.healthSampleModel(row));
  }

  async exportSnapshot(tenant: TenantContext): Promise<IntelligenceSnapshot> {
    const [timeline, projects, commitments, relationships, workflows, triggerRules, triggerEvents,
      verifications, conflicts, preparations, attentionStates, driftSignals, scenes, reviews, connections,
      homeEntities, healthSamples] = await Promise.all([
      this.listTimeline(tenant, {limit: MAX_LIMIT}), this.listProjects(tenant, undefined, MAX_LIMIT),
      this.listCommitments(tenant, {limit: MAX_LIMIT}), this.listRelationships(tenant, MAX_LIMIT),
      this.listWorkflows(tenant, undefined, MAX_LIMIT), this.listTriggerRules(tenant), this.listTriggerEvents(tenant, MAX_LIMIT),
      this.listActionVerifications(tenant), this.listClaimConflicts(tenant), this.listPreparations(tenant, undefined, MAX_LIMIT),
      this.listAttentionStates(tenant, MAX_LIMIT), this.listDriftSignals(tenant, undefined, MAX_LIMIT),
      this.listScenes(tenant, MAX_LIMIT), this.listReviews(tenant, MAX_LIMIT), this.listConnections(tenant),
      this.listHomeEntities(tenant), this.listHealthSamples(tenant, {limit: MAX_LIMIT}),
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
    return {id: row.id, revisionId: row.revisionId, name: this.decrypt(row.name, "trigger-rule", row.id) ?? "",
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
    return {id: row.id, workspaceId: row.workspaceId, subjectUserId: row.subjectUserId, revisionId: row.revisionId,
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
