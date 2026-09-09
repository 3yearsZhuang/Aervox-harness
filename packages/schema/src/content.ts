/**
 * Aervox｜思隅 @aervox/database — 内容/资源实体表
 *
 * 规则依据：docs/reference/PRD.md §8 数据模型（Attachment / EmbeddingIndex）
 * CAP-012 扩展：用途声明、解析管线、OCR 置信度、裁剪/转文字
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
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
    /** CAP-012 FR-EXT-001：用途声明 */
    purpose: text("purpose"), // "question" | "chart" | "code_screenshot" | "reading"
    /** CAP-012：解析状态（与 scanStatus 分离：scan=安全扫描，parse=OCR/内容提取） */
    parseStatus: text("parse_status").notNull().default("pending"), // "pending" | "parsing" | "completed" | "failed" | "low_confidence"
    /** CAP-012 BR-EXT-001：幂等键（用于安全重试解析） */
    idempotencyKey: text("idempotency_key"),
    deletedAt: text("deleted_at"),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("attachments_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);

/**
 * CAP-012 FR-EXT-002：附件解析结果（OCR/内容提取）
 *
 * 每次解析产生一行；裁剪/重传/转文字产生新版本，旧版本标记 supersededAt。
 * 支持低置信标记、幂等重试和派生物追踪。
 */
export const attachmentParseResults = sqliteTable(
  "attachment_parse_results",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    /** → attachments.id */
    attachmentId: text("attachment_id")
      .notNull()
      .references(() => attachments.id, { onDelete: "cascade" }),
    /** 解析状态 */
    parseStatus: text("parse_status").notNull().default("pending"), // "pending" | "parsing" | "completed" | "failed" | "low_confidence"
    /** OCR/解析结果文本 */
    parsedText: text("parsed_text"),
    /** OCR 置信度 0-1（BR-EXT-001） */
    confidence: integer("confidence"),
    /** 解析失败原因 */
    parseError: text("parse_error"),
    /** 裁剪区域 JSON: {x, y, width, height} */
    cropData: text("crop_data", { mode: "json" }),
    /** 操作类型: "ocr"（自动解析） | "crop"（用户裁剪） | "text"（用户转文字） */
    operation: text("operation").notNull().default("ocr"),
    /** 幂等键（用于安全重试，BR-EXT-001 AC-02） */
    idempotencyKey: text("idempotency_key"),
    /** 旧版本被取代的时间戳 */
    supersededAt: text("superseded_at"),
    ...timestampColumns,
  },
  (table) => ({
    attachmentIdx: index("attachment_parse_results_attachment_idx").on(table.attachmentId),
    tenantIdx: index("attachment_parse_results_tenant_idx").on(table.workspaceId, table.subjectUserId),
    idemIdx: uniqueIndex("attachment_parse_results_idem_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.idempotencyKey,
    ),
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
