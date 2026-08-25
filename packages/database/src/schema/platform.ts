/**
 * Aervox｜思隅 @aervox/database — 平台/运营实体表
 *
 * 规则依据：docs/reference/PRD.md §8 数据模型
 * （ScheduledJob / Notification / PromptVersion / ModelRun / ContextManifest / AuditRecord）
 *
 * 注意：prompt_versions 为系统级表（无租户列）；model_runs ↔ context_manifests 为循环引用，
 * 采用单向 FK（context_manifests.model_run_id）+ 应用层维护 model_runs.context_manifest_id。
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

/** 计划任务可见状态 */
export const scheduledJobs = sqliteTable(
  "scheduled_jobs",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    jobType: text("job_type").notNull(), // "diary" | "memory" | "ocr" | "embedding" | "notification"
    subjectId: text("subject_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    runAt: text("run_at").notNull(),
    status: text("status").notNull().default("scheduled"), // "scheduled" | "running" | "done" | "failed"
    attemptCount: integer("attempt_count").notNull().default(0),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdemIdx: uniqueIndex("scheduled_jobs_tenant_idempotency_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.idempotencyKey,
    ),
    tenantRunIdx: index("scheduled_jobs_tenant_run_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.runAt,
    ),
  }),
);

/** 通知（复习/日记/计划提醒；受免打扰与撤销约束） */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    type: text("type").notNull(), // "review" | "diary" | "scheduled"
    scheduledAt: text("scheduled_at").notNull(),
    sentAt: text("sent_at"),
    channel: text("channel").notNull(), // "push" | "email" | "in_app"
    status: text("status").notNull().default("scheduled"), // "scheduled" | "sent" | "failed" | "dismissed"
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("notifications_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);

/** 提示词版本（系统级，无租户列；教学/记忆/日记/安全提示词独立版本化与回滚） */
export const promptVersions = sqliteTable(
  "prompt_versions",
  {
    id: text("id").primaryKey(),
    purpose: text("purpose").notNull(), // "teaching" | "memory" | "diary" | "safety"
    version: integer("version").notNull(),
    checksum: text("checksum").notNull(),
    status: text("status").notNull().default("active"), // "draft" | "active" | "retired"
    approvedAt: text("approved_at"),
    ...timestampColumns,
  },
  (table) => ({
    purposeVersionIdx: uniqueIndex("prompt_versions_purpose_version_idx").on(
      table.purpose,
      table.version,
    ),
  }),
);

/** 模型运行记录（记录模型选择/上下文清单/成本/安全结果，默认不复制完整敏感 Prompt） */
export const modelRuns = sqliteTable(
  "model_runs",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    purpose: text("purpose").notNull(),
    provider: text("provider").notNull(),
    modelId: text("model_id").notNull(),
    promptVersionId: text("prompt_version_id").references(() => promptVersions.id),
    contextManifestId: text("context_manifest_id"), // → context_manifests.id（应用层维护，避免循环外键）
    latencyMs: integer("latency_ms"),
    tokenUsage: text("token_usage", { mode: "json" }), // { prompt, completion, total }
    cost: integer("cost"), // 成本（微单位整数，避免浮点误差）
    status: text("status").notNull().default("started"), // "started" | "completed" | "failed" | "blocked"
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("model_runs_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);

/** 上下文清单（本次模型实际选取的来源与权限快照，不默认复制来源正文） */
export const contextManifests = sqliteTable(
  "context_manifests",
  {
    id: text("id").primaryKey(),
    modelRunId: text("model_run_id")
      .notNull()
      .references(() => modelRuns.id, { onDelete: "cascade" }),
    purpose: text("purpose").notNull(),
    sourceArtifactId: text("source_artifact_id").notNull(), // → source_artifacts.id
    sourceRevisionId: text("source_revision_id").notNull(),
    selectionReason: text("selection_reason"),
    permissionSnapshot: text("permission_snapshot", { mode: "json" }),
    tokenBudget: integer("token_budget"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    modelRunIdx: index("context_manifests_model_run_idx").on(table.modelRunId),
  }),
);

/** 权限/导出/删除/插件/管理员等高风险操作审计（操作者与数据主体不可混用） */
export const auditRecords = sqliteTable(
  "audit_records",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    actorType: text("actor_type").notNull(), // "system" | "user" | "admin" | "plugin"
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    metadata: text("metadata", { mode: "json" }),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    tenantActorIdx: index("audit_records_tenant_actor_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.actorId,
    ),
    subjectIdx: index("audit_records_subject_idx").on(table.subjectType, table.subjectId),
  }),
);

/** 服务端工具权限/限额/审批策略（系统级，无租户列；模型请求不等于授权） */
export const toolPolicies = sqliteTable(
  "tool_policies",
  {
    id: text("id").primaryKey(),
    purpose: text("purpose").notNull(), // 工具使用场景
    toolName: text("tool_name").notNull(),
    scope: text("scope").notNull().default("all"), // "all" | 租户/角色限定
    approvalMode: text("approval_mode").notNull().default("auto"), // "auto" | "require_approval" | "denied"
    timeoutMs: integer("timeout_ms"),
    quota: integer("quota"),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("active"), // "draft" | "active" | "retired"
    ...timestampColumns,
  },
  (table) => ({
    purposeToolVersionIdx: uniqueIndex("tool_policies_purpose_tool_version_idx").on(
      table.purpose,
      table.toolName,
      table.version,
    ),
  }),
);

/** 教学/记忆/日记/安全评估集元数据（系统级，无租户列） */
export const evalSets = sqliteTable(
  "eval_sets",
  {
    id: text("id").primaryKey(),
    purpose: text("purpose").notNull(), // "teaching" | "memory" | "diary" | "safety"
    version: integer("version").notNull(),
    language: text("language").notNull().default("zh-CN"),
    domain: text("domain").notNull(),
    sampleCount: integer("sample_count").notNull().default(0),
    annotationPolicy: text("annotation_policy", { mode: "json" }),
    status: text("status").notNull().default("draft"), // "draft" | "approved" | "retired"
    ...timestampColumns,
  },
  (table) => ({
    purposeVersionIdx: uniqueIndex("eval_sets_purpose_version_idx").on(
      table.purpose,
      table.version,
    ),
  }),
);
