/**
 * Aervox｜思隅 @aervox/database — CAP-033 主动智能模式本地画像数据面
 *
 * 这些表与普通记忆/分析表隔离，所有正文和派生数据都带有 tenant、授权修订
 * 与 processingBoundary 溯源。运行时必须由本地 Host 保证 local_only；数据库层
 * 不将主动画像数据写入 outbox 或远程同步表。
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

/**
 * 当前版本完整画像授权包的来源清单。它是能力 manifest 的默认基线，
 * 不是绕过 OS 权限的通配符；每项仍需由本地 Permission Broker 回执。
 * mandatory 表示「当前版本支持、必须授予才能激活」的最小集合：与
 * contracts 的 PROFILE_CAPABILITY_CATALOG.required 保持一致——无平台
 * Provider 的来源（通信/位置/传感器/敏感资料）不阻塞激活，其中传感器与
 * 敏感资料经外部连接（Home Assistant / 小米运动健康）显式授予。
 */
export const FULL_PROFILE_SOURCE_MANIFEST = [
  { sourceKey: "aervox.activity", purpose: "profile.observe", osCapability: "aervox.activity", mandatory: true },
  { sourceKey: "aervox.operation", purpose: "profile.observe", osCapability: "aervox.operation", mandatory: true },
  { sourceKey: "device.app_activity", purpose: "profile.observe", osCapability: "os.app_activity", mandatory: true },
  { sourceKey: "device.browser_activity", purpose: "profile.observe", osCapability: "os.browser_history", mandatory: true },
  { sourceKey: "device.input_content", purpose: "profile.observe", osCapability: "os.input", mandatory: true },
  { sourceKey: "device.clipboard", purpose: "profile.observe", osCapability: "os.clipboard", mandatory: true },
  { sourceKey: "device.screen_capture", purpose: "profile.observe", osCapability: "os.screen_capture", mandatory: true },
  { sourceKey: "filesystem.full_disk_watch", purpose: "profile.observe", osCapability: "os.files", mandatory: true },
  { sourceKey: "external.communication", purpose: "profile.observe", osCapability: "os.communications", mandatory: false },
  { sourceKey: "device.microphone", purpose: "profile.observe", osCapability: "os.microphone", mandatory: true },
  { sourceKey: "device.camera", purpose: "profile.observe", osCapability: "os.camera", mandatory: true },
  { sourceKey: "device.location", purpose: "profile.observe", osCapability: "os.location", mandatory: false },
  { sourceKey: "device.sensors", purpose: "profile.observe", osCapability: "os.sensors", mandatory: false },
  { sourceKey: "restricted.profile", purpose: "profile.observe", osCapability: "os.restricted_profile", mandatory: false },
  { sourceKey: "background.persistent", purpose: "profile.persist", osCapability: "os.background", mandatory: true },
  { sourceKey: "action.local", purpose: "action.authorize", osCapability: "action.local", mandatory: true },
  { sourceKey: "action.external", purpose: "action.authorize", osCapability: "action.external", mandatory: true },
  { sourceKey: "action.privileged", purpose: "action.authorize", osCapability: "action.privileged", mandatory: true },
  { sourceKey: "action.irreversible", purpose: "action.authorize", osCapability: "action.irreversible", mandatory: true },
] as const;

/** 版本化全量画像授权包（一个租户/设备可有多次修订） */
export const proactiveProfileRevisions = sqliteTable(
  "proactive_profile_revisions",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    profileVersion: text("profile_version").notNull().default("full_profile_v1"),
    revision: integer("revision").notNull().default(1),
    deviceId: text("device_id").notNull(),
    desiredState: text("desired_state").notNull().default("none"), // none|enabled|paused|revoking|revoked
    status: text("status").notNull().default("draft"), // draft|active|superseded|revoked
    fullAccessRequired: integer("full_access_required", { mode: "boolean" }).notNull().default(true),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    manifestJson: text("manifest_json").notNull().default("{}"),
    grantSetHash: text("grant_set_hash"),
    confirmedAt: text("confirmed_at"),
    revokedAt: text("revoked_at"),
    ...timestampColumns,
  },
  (table) => ({
    tenantVersionRevisionIdx: uniqueIndex("proactive_profile_tenant_version_revision_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.profileVersion,
      table.deviceId,
      table.revision,
    ),
    tenantDeviceIdx: index("proactive_profile_tenant_device_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.deviceId,
      table.status,
    ),
    activeIdx: index("proactive_profile_active_idx").on(table.workspaceId, table.subjectUserId, table.status),
  }),
);

/** 授权包中的单项来源/OS 能力回执，可独立撤销 */
export const proactiveSourceGrants = sqliteTable(
  "proactive_source_grants",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => proactiveProfileRevisions.id, { onDelete: "cascade" }),
    ...tenantColumns,
    sourceKey: text("source_key").notNull(),
    purpose: text("purpose").notNull(),
    scope: text("scope").notNull(),
    osCapability: text("os_capability").notNull(),
    state: text("state").notNull().default("requested"), // requested|granted|denied|revoked|expired
    mandatory: integer("mandatory", { mode: "boolean" }).notNull().default(true),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    grantVersion: integer("grant_version").notNull().default(1),
    metadataJson: text("metadata_json").notNull().default("{}"),
    grantedAt: text("granted_at"),
    revokedAt: text("revoked_at"),
    lastVerifiedAt: text("last_verified_at"),
    ...timestampColumns,
  },
  (table) => ({
    revisionSourcePurposeIdx: uniqueIndex("proactive_source_revision_source_purpose_idx").on(
      table.revisionId,
      table.sourceKey,
      table.purpose,
    ),
    tenantStateIdx: index("proactive_source_tenant_state_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.state,
    ),
    tenantSourceIdx: index("proactive_source_tenant_source_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.sourceKey,
    ),
  }),
);

/** 设备级主动处理激活 epoch/heartbeat */
export const proactiveActivationLeases = sqliteTable(
  "proactive_activation_leases",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => proactiveProfileRevisions.id, { onDelete: "cascade" }),
    ...tenantColumns,
    deviceId: text("device_id").notNull(),
    epoch: text("epoch").notNull(),
    status: text("status").notNull().default("active"), // active|expired|ended|revoked
    localReady: integer("local_ready", { mode: "boolean" }).notNull().default(false),
    fullAccessSnapshot: integer("full_access_snapshot", { mode: "boolean" }).notNull().default(false),
    issuedAt: text("issued_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    heartbeatAt: text("heartbeat_at").notNull(),
    endedAt: text("ended_at"),
    endReason: text("end_reason"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    ...timestampColumns,
  },
  (table) => ({
    tenantDeviceEpochIdx: uniqueIndex("proactive_activation_tenant_device_epoch_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.deviceId,
      table.epoch,
    ),
    tenantActiveIdx: index("proactive_activation_tenant_active_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.deviceId,
      table.status,
    ),
  }),
);

/** 原始捕获副本；默认保留 7 天，必须先完成记忆提炼才能物理清理 */
export const proactiveCaptures = sqliteTable(
  "proactive_captures",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => proactiveProfileRevisions.id, { onDelete: "cascade" }),
    sourceGrantId: text("source_grant_id")
      .notNull()
      .references(() => proactiveSourceGrants.id, { onDelete: "restrict" }),
    ...tenantColumns,
    sourceKey: text("source_key").notNull(),
    contentType: text("content_type").notNull(),
    payloadText: text("payload_text"),
    payloadJson: text("payload_json"),
    checksum: text("checksum").notNull(),
    byteSize: integer("byte_size").notNull().default(0),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    observedAt: text("observed_at").notNull(),
    ingestedAt: text("ingested_at").notNull(),
    retentionUntil: text("retention_until").notNull(),
    distillationStatus: text("distillation_status").notNull().default("pending"), // pending|distilled|failed|blocked|deleted
    distillationAttemptCount: integer("distillation_attempt_count").notNull().default(0),
    lastDistillationError: text("last_distillation_error"),
    retentionBlockedAt: text("retention_blocked_at"),
    distilledAt: text("distilled_at"),
    distilledMemoryIdsJson: text("distilled_memory_ids_json").notNull().default("[]"),
    deletedAt: text("deleted_at"),
    ...timestampColumns,
  },
  (table) => ({
    tenantObservedIdx: index("proactive_capture_tenant_observed_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.observedAt,
    ),
    tenantRetentionIdx: index("proactive_capture_tenant_retention_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.retentionUntil,
      table.distillationStatus,
    ),
    revisionIdx: index("proactive_capture_revision_idx").on(table.revisionId),
  }),
);

/** 由原始捕获归一化出的行为观察；仍绑定来源授权与本地处理边界 */
export const proactiveObservations = sqliteTable(
  "proactive_observations",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => proactiveProfileRevisions.id, { onDelete: "cascade" }),
    sourceGrantId: text("source_grant_id")
      .notNull()
      .references(() => proactiveSourceGrants.id, { onDelete: "restrict" }),
    ...tenantColumns,
    sourceKey: text("source_key").notNull(),
    observationType: text("observation_type").notNull(),
    subjectKey: text("subject_key").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    checksum: text("checksum").notNull(),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    algorithmVersion: text("algorithm_version").notNull().default("local-observation-v1"),
    observedAt: text("observed_at").notNull(),
    normalizedAt: text("normalized_at").notNull(),
    ...timestampColumns,
  },
  (table) => ({
    tenantObservedIdx: index("proactive_observation_tenant_observed_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.observedAt,
    ),
    revisionIdx: index("proactive_observation_revision_idx").on(table.revisionId),
    sourceIdx: index("proactive_observation_source_idx").on(table.sourceGrantId),
  }),
);

/** 本地画像声明/习惯候选及其证据链 */
export const proactiveProfileClaims = sqliteTable(
  "proactive_profile_claims",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => proactiveProfileRevisions.id, { onDelete: "cascade" }),
    ...tenantColumns,
    claimType: text("claim_type").notNull(),
    subjectKey: text("subject_key").notNull(),
    content: text("content").notNull(),
    state: text("state").notNull().default("inferred"), // observed|inferred|user_asserted|confirmed|rejected
    confidence: integer("confidence").notNull().default(0),
    algorithmVersion: text("algorithm_version").notNull().default("local-profile-v1"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    evidenceCaptureIdsJson: text("evidence_capture_ids_json").notNull().default("[]"),
    evidenceRefsJson: text("evidence_refs_json").notNull().default("[]"),
    sourceGrantIdsJson: text("source_grant_ids_json").notNull().default("[]"),
    firstObservedAt: text("first_observed_at"),
    lastObservedAt: text("last_observed_at"),
    confirmedAt: text("confirmed_at"),
    rejectedAt: text("rejected_at"),
    ...timestampColumns,
  },
  (table) => ({
    tenantStateIdx: index("proactive_claim_tenant_state_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.state,
    ),
    tenantTypeIdx: index("proactive_claim_tenant_type_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.claimType,
    ),
    revisionIdx: index("proactive_claim_revision_idx").on(table.revisionId),
  }),
);

/** 主动动作请求/执行审计；动作授权与画像观察权分离 */
export const proactiveActions = sqliteTable(
  "proactive_actions",
  {
    id: text("id").primaryKey(),
    revisionId: text("revision_id")
      .notNull()
      .references(() => proactiveProfileRevisions.id, { onDelete: "cascade" }),
    activationLeaseId: text("activation_lease_id").references(() => proactiveActivationLeases.id, {
      onDelete: "set null",
    }),
    ...tenantColumns,
    actionType: text("action_type").notNull(),
    target: text("target").notNull(),
    requestJson: text("request_json").notNull().default("{}"),
    authorizationScope: text("authorization_scope").notNull(),
    actionGrantRevision: text("action_grant_revision").notNull(),
    state: text("state").notNull().default("pending"), // pending|approved|running|executed|denied|failed|revoked
    requestedBy: text("requested_by").notNull(),
    approvedBy: text("approved_by"),
    approvedAt: text("approved_at"),
    reversible: integer("reversible", { mode: "boolean" }).notNull().default(true),
    external: integer("external", { mode: "boolean" }).notNull().default(false),
    startedAt: text("started_at"),
    finishedAt: text("finished_at"),
    outcomeJson: text("outcome_json"),
    error: text("error"),
    ...timestampColumns,
  },
  (table) => ({
    tenantStateIdx: index("proactive_action_tenant_state_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.state,
    ),
    tenantCreatedIdx: index("proactive_action_tenant_created_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.createdAt,
    ),
    revisionIdx: index("proactive_action_revision_idx").on(table.revisionId),
  }),
);

/** 主动智能模式生命周期/权限变更审计（租户隔离且不写远程 outbox） */
export const proactiveAuditEvents = sqliteTable(
  "proactive_audit_events",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    revisionId: text("revision_id").references(() => proactiveProfileRevisions.id, { onDelete: "set null" }),
    eventType: text("event_type").notNull(),
    actorId: text("actor_id").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    processingBoundary: text("processing_boundary").notNull().default("local_only"),
    occurredAt: text("occurred_at").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    tenantOccurredIdx: index("proactive_audit_tenant_occurred_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.occurredAt,
    ),
    resourceIdx: index("proactive_audit_resource_idx").on(table.resourceType, table.resourceId),
  }),
);
