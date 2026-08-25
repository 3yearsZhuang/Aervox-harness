/**
 * Aervox｜思隅 @aervox/database — 内容/资源实体表
 *
 * 规则依据：docs/reference/PRD.md §8 数据模型（Attachment / EmbeddingIndex）
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

/** 附件元数据（图片/论文/试卷/导出文件；业务库不存大对象正文） */
export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    objectKey: text("object_key").notNull(), // 对象存储 Key
    mediaType: text("media_type").notNull(),
    size: integer("size").notNull().default(0),
    scanStatus: text("scan_status").notNull().default("pending"), // "pending" | "clean" | "infected" | "error"
    sourceLicense: text("source_license"),
    deletedAt: text("deleted_at"),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("attachments_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);

/** 向量/全文派生索引元数据（来源失效后删除或重建） */
export const embeddingIndexes = sqliteTable(
  "embedding_indexes",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    sourceArtifactId: text("source_artifact_id").notNull(), // → source_artifacts.id
    sourceRevisionId: text("source_revision_id").notNull(),
    modelId: text("model_id").notNull(),
    dimension: integer("dimension").notNull().default(0),
    indexVersion: integer("index_version").notNull().default(1),
    status: text("status").notNull().default("pending"), // "pending" | "indexed" | "failed" | "invalidated"
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("embedding_indexes_tenant_idx").on(table.workspaceId, table.subjectUserId),
    sourceIdx: index("embedding_indexes_source_idx").on(table.sourceArtifactId),
  }),
);
