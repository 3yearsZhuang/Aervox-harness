/**
 * Aervox｜思隅 @aervox/database — 人格与上下文快照实体表（CAP-019/CAP-020）
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

/** 人格（多人格模板，CAP-019）；删除采用归档而非物理删除 */
export const personas = sqliteTable(
  "personas",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    source: text("source").notNull().default("user_created"), // "builtin" | "user_created" | "imported"
    status: text("status").notNull().default("active"), // "active" | "archived"
    /** 模板审核状态：draft → pending_review → approved / rejected */
    reviewStatus: text("review_status").notNull().default("draft"), // "draft" | "pending_review" | "approved" | "rejected"
    /** 审核备注（审核意见或拒绝理由） */
    reviewNotes: text("review_notes").notNull().default(""),
    /** 审核时间 ISO-8601 */
    reviewedAt: text("reviewed_at"),
    currentRevisionId: text("current_revision_id").notNull(),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("personas_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);

/** 人格不可变修订（配置 JSON + checksum；编辑生成新修订，不物理覆盖） */
export const personaRevisions = sqliteTable(
  "persona_revisions",
  {
    id: text("id").primaryKey(),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    config: text("config", { mode: "json" }).notNull(), // PersonaRevisionConfig
    checksum: text("checksum").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    personaRevisionIdx: uniqueIndex("persona_revisions_persona_revision_idx").on(
      table.personaId,
      table.revision,
    ),
    personaIdx: index("persona_revisions_persona_idx").on(table.personaId),
  }),
);

/** 当前激活人格（每租户一条条件唯一，通过 upsert 维护） */
export const personaSelections = sqliteTable(
  "persona_selections",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    revisionId: text("revision_id").notNull(),
    selectedAt: text("selected_at").notNull(),
    ...timestampColumns,
  },
  (table) => ({
    tenantUniqueIdx: uniqueIndex("persona_selections_tenant_unique_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
  }),
);

/** Turn 级 PersonaContextSnapshot（审计/重放；不含完整敏感 Prompt） */
export const personaTurnContexts = sqliteTable(
  "persona_turn_contexts",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    turnId: text("turn_id").notNull(),
    personaId: text("persona_id").notNull(),
    revisionId: text("revision_id").notNull(),
    revisionChecksum: text("revision_checksum").notNull(),
    promptChecksum: text("prompt_checksum").notNull(),
    skillChecksums: text("skill_checksums", { mode: "json" }).notNull().default([]),
    mcpToolIds: text("mcp_tool_ids", { mode: "json" }).notNull().default([]),
    voice: text("voice", { mode: "json" }),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    tenantTurnIdx: uniqueIndex("persona_turn_contexts_tenant_turn_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.turnId,
    ),
    tenantIdx: index("persona_turn_contexts_tenant_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
  }),
);

/**
 * 人格切换日志（CAP-019）
 *
 * 记录每次人格切换的来源/目标/原因，用于审计、回滚和人格回归评估。
 */
export const personaSwitchLogs = sqliteTable(
  "persona_switch_logs",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    /** 切换到的目标人格 ID */
    personaId: text("persona_id").notNull(),
    /** 目标修订 ID */
    revisionId: text("revision_id").notNull(),
    /** 切换前的人格 ID（首次激活为 null） */
    previousPersonaId: text("previous_persona_id"),
    /** 切换前的修订 ID（首次激活为 null） */
    previousRevisionId: text("previous_revision_id"),
    /** 切换原因：user_initiated | rollback | system_default */
    switchReason: text("switch_reason").notNull().default("user_initiated"),
    /** 切换时的回归评估备注 */
    regressionNotes: text("regression_notes"),
    switchedAt: text("switched_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    tenantIdx: index("persona_switch_logs_tenant_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
    tenantPersonaIdx: index("persona_switch_logs_tenant_persona_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.personaId,
    ),
  }),
);

/**
 * 人格记忆范围配置（CAP-019）
 *
 * 跨人格记忆默认隔离；显式共享前显示范围并取得确认。
 * 每个 (workspace, subject, persona) 一条配置记录。
 */
export const personaMemoryScopes = sqliteTable(
  "persona_memory_scopes",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    /** 记忆隔离策略：isolated（默认隔离）| shared（显式共享） */
    memoryPolicy: text("memory_policy").notNull().default("isolated"), // "isolated" | "shared"
    /** 共享目标人格 ID 列表（JSON 数组） */
    sharedPersonaIds: text("shared_persona_ids", { mode: "json" }).notNull().default([]),
    /** 共享的记忆类别（JSON 数组：learning | preference | diary | fact） */
    sharedCategories: text("shared_categories", { mode: "json" }).notNull().default([]),
    /** 共享确认时间 ISO-8601（用户确认共享范围的时间） */
    confirmedAt: text("confirmed_at"),
    ...timestampColumns,
  },
  (table) => ({
    tenantPersonaUniqueIdx: uniqueIndex("persona_memory_scopes_tenant_persona_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.personaId,
    ),
  }),
);
