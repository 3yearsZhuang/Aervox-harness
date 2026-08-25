/**
 * Aervox｜思隅 @aervox/database — 统一来源链 + 记忆版本/证据/事件实体表
 *
 * 规则依据：docs/reference/PRD.md §8 数据模型
 * （SourceArtifact / SourceRevision / MemoryRevision / MemoryEvidence / MemoryEvent）
 *
 * 关键不变量：
 * - 各来源类型通过 SourceArtifact 建立真实外键，禁止无法约束的 `sourceType + sourceId`；
 * - 来源的 occurredAt 用于业务窗口归属，ingestedAt 用于迟到/重放审计，两者不得混用；
 * - 来源删除后保留最少 tombstone（不含已删内容），MemoryEvidence 不得随来源级联删除。
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";
import { memoryRecords } from "./memories.js";

/** 统一来源工件（消息/作答/附件/日记/外部来源的真实外键端点） */
export const sourceArtifacts = sqliteTable(
  "source_artifacts",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    kind: text("kind").notNull(), // "message" | "question_attempt" | "attachment" | "diary" | "external"
    ownerModule: text("owner_module").notNull(), // 责任模块
    currentRevisionId: text("current_revision_id"), // → source_revisions.id（应用层维护，避免循环外键）
    occurredAt: text("occurred_at").notNull(), // 业务窗口归属时间
    ingestedAt: text("ingested_at").notNull(), // 数据管道摄取时间
    deletedAt: text("deleted_at"),
    status: text("status").notNull().default("active"), // "active" | "deleted" | "tombstoned"
    ...timestampColumns,
  },
  (table) => ({
    tenantKindIdx: index("source_artifacts_tenant_kind_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.kind,
    ),
  }),
);

/** 来源版本（内容/校验和/版本号；来源删除后置空 content 保留 tombstone） */
export const sourceRevisions = sqliteTable(
  "source_revisions",
  {
    id: text("id").primaryKey(),
    artifactId: text("artifact_id")
      .notNull()
      .references(() => sourceArtifacts.id, { onDelete: "cascade" }),
    checksum: text("checksum").notNull(), // 不可逆散列
    content: text("content"), // 正文（删除后可空）
    version: integer("version").notNull().default(1),
    supersededAt: text("superseded_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    artifactVersionIdx: index("source_revisions_artifact_version_idx").on(
      table.artifactId,
      table.version,
    ),
  }),
);

/** 记忆版本（压缩/纠错/合并产生新版本，不物理覆盖旧版本） */
export const memoryRevisions = sqliteTable(
  "memory_revisions",
  {
    id: text("id").primaryKey(),
    memoryId: text("memory_id")
      .notNull()
      .references(() => memoryRecords.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    confidence: integer("confidence").notNull().default(0),
    importance: integer("importance").notNull().default(0),
    algorithmVersion: text("algorithm_version"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    memoryIdx: index("memory_revisions_memory_idx").on(table.memoryId),
  }),
);

/** 记忆证据（可约束的来源关联；来源删除后保留最少 tombstone） */
export const memoryEvidence = sqliteTable(
  "memory_evidence",
  {
    id: text("id").primaryKey(),
    memoryRevisionId: text("memory_revision_id")
      .notNull()
      .references(() => memoryRevisions.id, { onDelete: "cascade" }),
    sourceArtifactId: text("source_artifact_id").notNull(), // → source_artifacts.id（不级联，来源删除保留 tombstone）
    sourceRevisionId: text("source_revision_id").notNull(),
    sourceRange: text("source_range"), // 来源内引用范围
    status: text("status").notNull().default("active"), // "active" | "tombstoned"
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    revisionIdx: index("memory_evidence_revision_idx").on(table.memoryRevisionId),
  }),
);

/** 记忆审计事件（生成/晋升/衰减/锁定/冲突/失效/删除） */
export const memoryEvents = sqliteTable(
  "memory_events",
  {
    id: text("id").primaryKey(),
    memoryId: text("memory_id")
      .notNull()
      .references(() => memoryRecords.id, { onDelete: "cascade" }),
    action: text("action").notNull(), // "created" | "promoted" | "decayed" | "locked" | "conflict" | "invalidated" | "deleted"
    fromTier: text("from_tier"),
    toTier: text("to_tier"),
    reason: text("reason"),
    actorType: text("actor_type").notNull().default("system"), // "system" | "user" | "admin"
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    memoryIdx: index("memory_events_memory_idx").on(table.memoryId),
  }),
);
