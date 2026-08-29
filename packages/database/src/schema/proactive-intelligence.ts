/**
 * CAP-033/034/035 local proactive intelligence, home environment, and health data.
 *
 * Sensitive text/JSON columns are encrypted by the repository. Tables remain queryable through
 * metadata columns while all records preserve the local_only processing boundary.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

export const proactiveTimelineEvents = sqliteTable(
  "proactive_timeline_events",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    sourceGrantId: text("source_grant_id"),
    sourceKey: text("source_key").notNull(),
    eventType: text("event_type").notNull(),
    subjectKey: text("subject_key").notNull(),
    title: text("title").notNull(),
    summary: text("summary"),
    payloadJson: text("payload_json").notNull().default("{}"),
    privacyClass: text("privacy_class").notNull().default("private"),
    projectId: text("project_id"),
    relationshipId: text("relationship_id"),
    checksum: text("checksum").notNull(),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    occurredAt: text("occurred_at").notNull(),
    ...timestampColumns,
  },
  (table) => ({
    tenantOccurredIdx: index("proactive_timeline_tenant_occurred_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.occurredAt,
    ),
    tenantSubjectIdx: index("proactive_timeline_tenant_subject_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.subjectKey,
    ),
    tenantChecksumIdx: uniqueIndex("proactive_timeline_tenant_checksum_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.checksum,
    ),
  }),
);

export const proactiveProjects = sqliteTable(
  "proactive_projects",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    title: text("title").notNull(),
    objective: text("objective"),
    description: text("description"),
    status: text("status").notNull().default("active"),
    priority: integer("priority").notNull().default(50),
    confidence: integer("confidence").notNull().default(0),
    dueAt: text("due_at"),
    lastActivityAt: text("last_activity_at"),
    sourceTimelineIdsJson: text("source_timeline_ids_json").notNull().default("[]"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantStatusIdx: index("proactive_project_tenant_status_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.status,
    ),
    tenantActivityIdx: index("proactive_project_tenant_activity_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.lastActivityAt,
    ),
  }),
);

export const proactiveRelationships = sqliteTable(
  "proactive_relationships",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    relationshipType: text("relationship_type").notNull().default("contact"),
    displayName: text("display_name").notNull(),
    notes: text("notes"),
    state: text("state").notNull().default("active"),
    confidence: integer("confidence").notNull().default(0),
    lastInteractionAt: text("last_interaction_at"),
    sourceGrantIdsJson: text("source_grant_ids_json").notNull().default("[]"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantStateIdx: index("proactive_relationship_tenant_state_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.state,
    ),
  }),
);

export const proactiveCommitments = sqliteTable(
  "proactive_commitments",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    projectId: text("project_id"),
    relationshipId: text("relationship_id"),
    content: text("content").notNull(),
    status: text("status").notNull().default("open"),
    importance: integer("importance").notNull().default(50),
    dueAt: text("due_at"),
    sourceTimelineId: text("source_timeline_id"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantDueIdx: index("proactive_commitment_tenant_due_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.status,
      table.dueAt,
    ),
  }),
);

export const proactiveWorkflowTemplates = sqliteTable(
  "proactive_workflow_templates",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    state: text("state").notNull().default("candidate"),
    triggerJson: text("trigger_json").notNull().default("{}"),
    stepsJson: text("steps_json").notNull().default("[]"),
    evidenceCount: integer("evidence_count").notNull().default(1),
    successCount: integer("success_count").notNull().default(0),
    failureCount: integer("failure_count").notNull().default(0),
    lastObservedAt: text("last_observed_at"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantStateIdx: index("proactive_workflow_tenant_state_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.state,
    ),
  }),
);

export const proactiveTriggerRules = sqliteTable(
  "proactive_trigger_rules",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    name: text("name").notNull(),
    triggerType: text("trigger_type").notNull(),
    conditionJson: text("condition_json").notNull().default("{}"),
    actionJson: text("action_json").notNull().default("{}"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    cooldownSeconds: integer("cooldown_seconds").notNull().default(3600),
    quietHoursJson: text("quiet_hours_json").notNull().default("{}"),
    lastTriggeredAt: text("last_triggered_at"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantEnabledIdx: index("proactive_trigger_rule_tenant_enabled_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.enabled,
    ),
  }),
);

export const proactiveTriggerEvents = sqliteTable(
  "proactive_trigger_events",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    ruleId: text("rule_id"),
    triggerType: text("trigger_type").notNull(),
    causeJson: text("cause_json").notNull().default("{}"),
    decision: text("decision").notNull(),
    reason: text("reason"),
    actionId: text("action_id"),
    occurredAt: text("occurred_at").notNull(),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    tenantOccurredIdx: index("proactive_trigger_event_tenant_occurred_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.occurredAt,
    ),
  }),
);

export const proactiveActionVerifications = sqliteTable(
  "proactive_action_verifications",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    actionId: text("action_id").notNull(),
    expectedJson: text("expected_json").notNull().default("{}"),
    observedJson: text("observed_json"),
    status: text("status").notNull().default("pending"),
    attemptCount: integer("attempt_count").notNull().default(0),
    verifiedAt: text("verified_at"),
    error: text("error"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantActionIdx: uniqueIndex("proactive_action_verification_tenant_action_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.actionId,
    ),
  }),
);

export const proactiveClaimConflicts = sqliteTable(
  "proactive_claim_conflicts",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    primaryClaimId: text("primary_claim_id").notNull(),
    conflictingClaimId: text("conflicting_claim_id").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("open"),
    resolution: text("resolution"),
    resolvedAt: text("resolved_at"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantStatusIdx: index("proactive_claim_conflict_tenant_status_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.status,
    ),
    claimPairIdx: uniqueIndex("proactive_claim_conflict_pair_idx").on(
      table.primaryClaimId,
      table.conflictingClaimId,
    ),
  }),
);

export const proactivePreparationBundles = sqliteTable(
  "proactive_preparation_bundles",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    projectId: text("project_id"),
    commitmentId: text("commitment_id"),
    title: text("title").notNull(),
    bundleJson: text("bundle_json").notNull().default("{}"),
    status: text("status").notNull().default("ready"),
    availableAt: text("available_at").notNull(),
    expiresAt: text("expires_at"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantAvailableIdx: index("proactive_preparation_tenant_available_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.status,
      table.availableAt,
    ),
  }),
);

export const proactiveAttentionStates = sqliteTable(
  "proactive_attention_states",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    windowStart: text("window_start").notNull(),
    windowEnd: text("window_end").notNull(),
    focusScore: integer("focus_score").notNull(),
    fatigueScore: integer("fatigue_score").notNull(),
    contextSwitches: integer("context_switches").notNull().default(0),
    errorSignals: integer("error_signals").notNull().default(0),
    recommendation: text("recommendation"),
    evidenceJson: text("evidence_json").notNull().default("[]"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantWindowIdx: index("proactive_attention_tenant_window_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.windowEnd,
    ),
  }),
);

export const proactiveDriftSignals = sqliteTable(
  "proactive_drift_signals",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    signalType: text("signal_type").notNull(),
    projectId: text("project_id"),
    expectedJson: text("expected_json").notNull().default("{}"),
    actualJson: text("actual_json").notNull().default("{}"),
    severity: integer("severity").notNull().default(0),
    state: text("state").notNull().default("open"),
    explanation: text("explanation"),
    detectedAt: text("detected_at").notNull(),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantStateIdx: index("proactive_drift_tenant_state_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.state,
    ),
  }),
);

export const proactiveSceneSnapshots = sqliteTable(
  "proactive_scene_snapshots",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    sceneType: text("scene_type").notNull(),
    applicationId: text("application_id"),
    payloadJson: text("payload_json").notNull().default("{}"),
    checksum: text("checksum").notNull(),
    capturedAt: text("captured_at").notNull(),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantCapturedIdx: index("proactive_scene_tenant_captured_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.capturedAt,
    ),
    tenantChecksumIdx: uniqueIndex("proactive_scene_tenant_checksum_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.checksum,
    ),
  }),
);

export const proactiveReviewReports = sqliteTable(
  "proactive_review_reports",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    periodType: text("period_type").notNull(),
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),
    summary: text("summary").notNull(),
    metricsJson: text("metrics_json").notNull().default("{}"),
    recommendationsJson: text("recommendations_json").notNull().default("[]"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantPeriodIdx: uniqueIndex("proactive_review_tenant_period_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.periodType,
      table.periodStart,
      table.periodEnd,
    ),
  }),
);

export const proactiveExternalConnections = sqliteTable(
  "proactive_external_connections",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").notNull(),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    endpoint: text("endpoint"),
    authType: text("auth_type").notNull(),
    credentialJson: text("credential_json").notNull().default("{}"),
    scopesJson: text("scopes_json").notNull().default("[]"),
    settingsJson: text("settings_json").notNull().default("{}"),
    state: text("state").notNull().default("active"),
    lastSyncAt: text("last_sync_at"),
    lastError: text("last_error"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantProviderIdx: index("proactive_connection_tenant_provider_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.provider,
      table.state,
    ),
  }),
);

export const proactiveHomeEntities = sqliteTable(
  "proactive_home_entities",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    ...tenantColumns,
    entityId: text("entity_id").notNull(),
    domain: text("domain").notNull(),
    displayName: text("display_name"),
    deviceClass: text("device_class"),
    allowedOpsJson: text("allowed_ops_json").notNull().default("[]"),
    stateJson: text("state_json").notNull().default("{}"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    sensitive: integer("sensitive", { mode: "boolean" }).notNull().default(false),
    lastSeenAt: text("last_seen_at"),
    ...timestampColumns,
  },
  (table) => ({
    connectionEntityIdx: uniqueIndex("proactive_home_connection_entity_idx").on(
      table.connectionId,
      table.entityId,
    ),
    tenantEnabledIdx: index("proactive_home_tenant_enabled_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.enabled,
    ),
  }),
);

export const proactiveHealthSamples = sqliteTable(
  "proactive_health_samples",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    ...tenantColumns,
    metric: text("metric").notNull(),
    localDate: text("local_date").notNull(),
    value: integer("value").notNull(),
    unit: text("unit").notNull(),
    sensitivity: text("sensitivity").notNull().default("low"),
    source: text("source").notNull().default("xiaomi_health"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    observedAt: text("observed_at").notNull(),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    tenantMetricDateIdx: uniqueIndex("proactive_health_tenant_metric_date_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.connectionId,
      table.metric,
      table.localDate,
    ),
  }),
);
