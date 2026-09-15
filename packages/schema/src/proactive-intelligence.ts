/**
 * CAP-033/034/035 local proactive intelligence, home environment, and health data.
 *
 * Sensitive text/JSON columns are encrypted by the repository. Tables remain queryable through
 * metadata columns while all records preserve the local_only processing boundary.
 */
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { timestampColumns } from "./common.js";

export const proactiveTimelineEvents = sqliteTable(
  "proactive_timeline_events",
  {
    id: text("id").primaryKey(),
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
    proactiveTimelineLocalChecksumUniqueIdx: uniqueIndex("proactive_timeline_local_checksum_idx").on(
      table.checksum,
    ),
    proactiveTimelineLocalOccurredIdx: index("proactive_timeline_local_occurred_idx").on(
      table.occurredAt,
    ),
    proactiveTimelineLocalSubjectIdx: index("proactive_timeline_local_subject_idx").on(
      table.subjectKey,
    ),
  }),
);

export const proactiveProjects = sqliteTable(
  "proactive_projects",
  {
    id: text("id").primaryKey(),
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
    localStatusIdx: index("proactive_project_local_status_idx").on(table.status),
  }),
);

export const proactiveRelationships = sqliteTable(
  "proactive_relationships",
  {
    id: text("id").primaryKey(),
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
    localStateIdx: index("proactive_relationship_local_state_idx").on(table.state),
  }),
);

export const proactiveCommitments = sqliteTable(
  "proactive_commitments",
  {
    id: text("id").primaryKey(),
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
    localDueIdx: index("proactive_commitment_local_due_idx").on(table.status, table.dueAt),
  }),
);

export const proactiveWorkflowTemplates = sqliteTable(
  "proactive_workflow_templates",
  {
    id: text("id").primaryKey(),
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
    proactiveWorkflowLocalStateIdx: index("proactive_workflow_local_state_idx").on(table.state),
  }),
);

export const proactiveTriggerRules = sqliteTable(
  "proactive_trigger_rules",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id").notNull(),
    /** 归属插件（CR-032 物化模式：Worker 从插件声明同步；内置规则为 NULL） */
    pluginId: text("plugin_id"),
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
    localEnabledIdx: index("proactive_trigger_rule_local_enabled_idx").on(table.enabled),
    pluginIdx: index("proactive_trigger_rules_plugin_idx").on(table.pluginId),
  }),
);

export const proactiveTriggerEvents = sqliteTable(
  "proactive_trigger_events",
  {
    id: text("id").primaryKey(),
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
    localOccurredIdx: index("proactive_trigger_event_local_occurred_idx").on(table.occurredAt),
  }),
);

export const proactiveActionVerifications = sqliteTable(
  "proactive_action_verifications",
  {
    id: text("id").primaryKey(),
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
    localActionUniqueIdx: uniqueIndex("proactive_action_verification_local_action_idx").on(
      table.actionId,
    ),
  }),
);

export const proactiveClaimConflicts = sqliteTable(
  "proactive_claim_conflicts",
  {
    id: text("id").primaryKey(),
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

    claimPairIdx: uniqueIndex("proactive_claim_conflict_pair_idx").on(
      table.primaryClaimId,
      table.conflictingClaimId,
    ),
    revisionPairIdx: index("proactive_claim_conflict_revision_pair_idx").on(
      table.revisionId,
      table.primaryClaimId,
      table.conflictingClaimId,
    ),
  }),
);

export const proactivePreparationBundles = sqliteTable(
  "proactive_preparation_bundles",
  {
    id: text("id").primaryKey(),
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
    proactivePreparationLocalAvailableIdx: index("proactive_preparation_local_available_idx").on(
      table.status,
      table.availableAt,
    ),
  }),
);

export const proactiveAttentionStates = sqliteTable(
  "proactive_attention_states",
  {
    id: text("id").primaryKey(),
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
    proactiveAttentionLocalWindowIdx: index("proactive_attention_local_window_idx").on(
      table.windowEnd,
    ),
  }),
);

export const proactiveDriftSignals = sqliteTable(
  "proactive_drift_signals",
  {
    id: text("id").primaryKey(),
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
    proactiveDriftLocalStateIdx: index("proactive_drift_local_state_idx").on(table.state),
  }),
);

export const proactiveSceneSnapshots = sqliteTable(
  "proactive_scene_snapshots",
  {
    id: text("id").primaryKey(),
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
    proactiveSceneLocalChecksumUniqueIdx: uniqueIndex("proactive_scene_local_checksum_idx").on(
      table.checksum,
    ),
  }),
);

export const proactiveReviewReports = sqliteTable(
  "proactive_review_reports",
  {
    id: text("id").primaryKey(),
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
    proactiveReviewLocalPeriodUniqueIdx: uniqueIndex("proactive_review_local_period_idx").on(
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
    proactiveConnectionLocalProviderIdx: index("proactive_connection_local_provider_idx").on(
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

  }),
);

export const proactiveHealthSamples = sqliteTable(
  "proactive_health_samples",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id").notNull(),
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
    proactiveHealthLocalMetricDateUniqueIdx: uniqueIndex("proactive_health_local_metric_date_idx").on(
      table.connectionId,
      table.metric,
      table.localDate,
    ),
  }),
);

/**
 * CR-033 E1 SituationModel 投影快照（纯派生物，可从事件流重建）。
 *
 * 存储 situation_model_v1 白名单投影的持久化副本；payloadJson 由 vault 加密。
 * 回填记录标记为 `backfill`，禁止静默合并或以 MAX(rowid) 选胜者。
 * 读取侧按 active revision、source grant、local_only 与 deny watermark 过滤。
 */
export const proactiveSituationSnapshots = sqliteTable(
  "proactive_situation_snapshots",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id").notNull(),
    schemaVersion: text("schema_version").notNull().default("situation_model_v1"),
    snapshotJson: text("snapshot_json").notNull(),
    checksum: text("checksum").notNull(),
    /** 回填记录标记：backfill | incremental | rebuild */
    origin: text("origin").notNull().default("incremental"),
    /** 重建 watermark：消费到的感知事件 SQLite ingestion sequence 上限 */
    lastEventSequence: integer("last_event_sequence").notNull().default(0),
    sourceEpochsJson: text("source_epochs_json").notNull().default("{}"),
    rebuiltAt: text("rebuilt_at"),
    localOnly: integer("local_only", { mode: "boolean" }).notNull().default(true),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    revisionSequenceIdx: uniqueIndex("proactive_situation_revision_sequence_idx").on(
      table.revisionId,
      table.lastEventSequence,
    ),
  }),
);

/**
 * CR-033 E2b 注意力预算状态（全局 + 插件各一行）。
 *
 * reserveVersion 为 CAS 版本：并发扣减必须按版本比对，防止超发。
 * 静态冷却/静音/全局硬上限仍由裁决器兜底，本表只承载预算水位。
 */
export const proactiveAttentionBudgets = sqliteTable(
  "proactive_attention_budgets",
  {
    id: text("id").primaryKey(),
    /** global | plugin */
    scope: text("scope").notNull(),
    pluginId: text("plugin_id"),
    budgetUnits: integer("budget_units").notNull(),
    maxUnits: integer("max_units").notNull(),
    consecutiveIgnores: integer("consecutive_ignores").notNull().default(0),
    /** CAS 版本：每次扣减/结算递增 */
    reserveVersion: integer("reserve_version").notNull().default(0),
    policyVersion: text("policy_version").notNull().default("budget-policy-v1"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    scopePluginIdx: uniqueIndex("proactive_budget_scope_plugin_idx").on(
      table.scope,
      table.pluginId,
    ),
  }),
);

/**
 * CR-033 E2b 干预回执账本（追加式，仅内核写入）。
 *
 * 只保存必要证据摘要（evidenceDigest）、规则/策略版本、抑制原因、
 * 预算变化与审计引用；不保存无必要的原始敏感内容。
 */
export const proactiveInterventionReceipts = sqliteTable(
  "proactive_intervention_receipts",
  {
    id: text("id").primaryKey(),
    actionId: text("action_id").notNull(),
    ruleId: text("rule_id").notNull(),
    pluginId: text("plugin_id"),
    decision: text("decision").notNull(),
    suppressionReason: text("suppression_reason"),
    ruleVersion: text("rule_version").notNull(),
    policyVersion: text("policy_version").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    budgetBefore: integer("budget_before").notNull(),
    budgetAfter: integer("budget_after").notNull(),
    globalBudgetAfter: integer("global_budget_after").notNull(),
    auditRef: text("audit_ref"),
    /** 幂等键：同一干预决策重复写入只保留一条 */
    idempotencyKey: text("idempotency_key").notNull(),
    issuedAt: text("issued_at").notNull(),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    idempotencyIdx: uniqueIndex("proactive_receipt_idempotency_idx").on(table.idempotencyKey),
    actionIdx: index("proactive_receipt_action_idx").on(table.actionId),
  }),
);

/** 预算反馈事件幂等账本：同一反馈只允许影响预算一次。 */
export const proactiveBudgetFeedbackEvents = sqliteTable(
  "proactive_budget_feedback_events",
  {
    id: text("id").primaryKey(),
    actionId: text("action_id").notNull(),
    scope: text("scope").notNull(),
    pluginId: text("plugin_id"),
    kind: text("kind").notNull(),
    weight: integer("weight_millis").notNull(),
    occurredAt: text("occurred_at").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    idempotencyIdx: uniqueIndex("proactive_budget_feedback_idempotency_idx").on(
      table.idempotencyKey,
    ),
  }),
);

/**
 * CR-033 E3 本地感知事件流（追加式，跨进程真源）。
 *
 * - sequence 为原子单调序列（写者连接内 MAX+1 分配）；
 * - idempotency_key 全局唯一：重复投递只保留一条；
 * - payload 摘要入列，原文经 vault 加密；local_only 语义继承 CR-023；
 * - 桌面端边沿聚合属于 E3 桌面适配器子 CR（Electron + Privacy Host 依赖）。
 */
export const perceptionEvents = sqliteTable(
  "perception_events",
  {
    id: text("id").primaryKey(),
    /** 原子单调序列（跨进程可见的 ingestion 顺序） */
    sequence: integer("sequence").notNull(),
    eventId: text("event_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    source: text("source").notNull(),
    deviceId: text("device_id").notNull(),
    activationEpoch: text("activation_epoch").notNull(),
    sourceGrantId: text("source_grant_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
    ingestedAt: text("ingested_at").notNull(),
    schemaVersion: text("schema_version").notNull().default("perception_event_v1"),
    payloadDigest: text("payload_digest").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    causalJson: text("causal_json"),
    /** ready | dead（处理失败进死信，保留待人工 reconciliation） */
    status: text("status").notNull().default("ready"),
    localOnly: integer("local_only", { mode: "boolean" }).notNull().default(true),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    ...timestampColumns,
  },
  (table) => ({
    sequenceIdx: uniqueIndex("perception_event_sequence_idx").on(table.sequence),
    idempotencyIdx: uniqueIndex("perception_event_idempotency_idx").on(table.idempotencyKey),
    sourceIdx: index("perception_event_source_idx").on(table.source, table.occurredAt),
  }),
);

/**
 * CR-033 E3 事件流消费者游标（consumer offset / ACK / 重放 / 过期 cursor）。
 */
export const perceptionEventConsumers = sqliteTable(
  "perception_event_consumers",
  {
    id: text("id").primaryKey(),
    /** 已 ACK 的最大 sequence */
    lastAckedSequence: integer("last_acked_sequence").notNull().default(0),
    cursorUpdatedAt: text("cursor_updated_at").notNull(),
    /** 过期标记：过期 consumer 需重置或重建后才能继续消费 */
    expired: integer("expired", { mode: "boolean" }).notNull().default(false),
    ...timestampColumns,
  },
  (table) => ({
    expiredIdx: index("perception_consumer_expired_idx").on(table.expired),
  }),
);
