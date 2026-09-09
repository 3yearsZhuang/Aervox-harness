/**
 * Aervox｜思隅 @aervox/database — 学习资料 Schema（CAP-011 学习资料整理）
 *
 * 覆盖：
 * - FR-LRN-002 资料生成与类型（5 种资料类型）
 * - FR-LRN-003 资料编辑与导出（版本链）
 * - BR-LRN-001 事实核验、版权与删除传播
 *
 * 表设计：
 * 1. study_materials — 资料身份（每条资料一行）
 * 2. material_versions — 资料版本（编辑产生新版本，原版本保留）
 * 3. material_sources — 引用来源（区分模型生成 vs 外部引用，含许可证和核验状态）
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

/** 学习资料身份表 */
export const studyMaterials = sqliteTable(
  "study_materials",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    /** 关联学习目标（可选） */
    goalId: text("goal_id"),
    /** 资料类型: "explanation" | "mindmap" | "exercises" | "reading" | "code" */
    type: text("type").notNull(),
    /** 资料标题 */
    title: text("title").notNull(),
    /** 当前版本 ID → material_versions.id */
    currentVersionId: text("current_version_id"),
    /** 生成状态: "generating" | "ready" | "failed" | "deleted" */
    status: text("status").notNull().default("generating"),
    /** 幂等键（用于安全重试） */
    idempotencyKey: text("idempotency_key"),
    /** 软删除 */
    deletedAt: text("deleted_at"),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("study_materials_tenant_idx").on(table.workspaceId, table.subjectUserId),
    goalIdx: index("study_materials_goal_idx").on(table.goalId),
  }),
);

/** 资料版本表（编辑产生新版本，不覆盖原版本） */
export const materialVersions = sqliteTable(
  "material_versions",
  {
    id: text("id").primaryKey(),
    materialId: text("material_id")
      .notNull()
      .references(() => studyMaterials.id, { onDelete: "cascade" }),
    ...tenantColumns,
    /** 版本号，从 1 递增 */
    version: integer("version").notNull().default(1),
    /** 资料正文（Markdown 或 JSON） */
    content: text("content").notNull(),
    /** 内容格式: "markdown" | "json" */
    format: text("format").notNull().default("markdown"),
    /** 编辑者标记: "model"（模型生成） | "user"（用户编辑） */
    author: text("author").notNull().default("model"),
    /** 旧版本被取代的时间戳 */
    supersededAt: text("superseded_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    materialVersionIdx: uniqueIndex("material_versions_mat_ver_idx").on(
      table.materialId,
      table.version,
    ),
    tenantIdx: index("material_versions_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);

/** 引用来源表（区分模型生成 vs 外部引用，含许可证和核验状态） */
export const materialSources = sqliteTable(
  "material_sources",
  {
    id: text("id").primaryKey(),
    materialVersionId: text("material_version_id")
      .notNull()
      .references(() => materialVersions.id, { onDelete: "cascade" }),
    ...tenantColumns,
    /** 来源类型: "model"（模型生成） | "external"（外部引用） */
    sourceType: text("source_type").notNull(),
    /** 来源 URI（外部引用时填写） */
    sourceUri: text("source_uri"),
    /** 来源标题 */
    sourceTitle: text("source_title"),
    /** 许可证状态: "confirmed" | "unconfirmed" | "restricted" */
    licenseStatus: text("license_status").notNull().default("unconfirmed"),
    /** 事实核验状态: "verified" | "needs_review" | "unverifiable" */
    verificationStatus: text("verification_status").notNull().default("needs_review"),
    /** 引用是否已失效（来源被删除时标记） */
    invalidatedAt: text("invalidated_at"),
    ...timestampColumns,
  },
  (table) => ({
    versionIdx: index("material_sources_version_idx").on(table.materialVersionId),
    tenantIdx: index("material_sources_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);