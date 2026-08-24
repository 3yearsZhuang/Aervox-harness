/**
 * Aervox｜思隅 @aervox/database — 记忆与记忆树实体表
 *
 * 规则依据：docs/architecture/adr/ADR-007-memory-tree-projection.md + SRS BR-MEM-001/003
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

/** 记忆记录表（四段记忆：临时/短期/长期/系统） */
export const memoryRecords = sqliteTable(
  "memory_records",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    layer: text("layer").notNull(), // "ephemeral" | "short_term" | "long_term" | "system"
    type: text("type").notNull(), // "user_fact" | "user_preference" | "learning_event" | "inference"
    content: text("content").notNull(),
    canonicalParentId: text("canonical_parent_id"),
    sourceTurnId: text("source_turn_id"),
    version: integer("version").notNull().default(1),
    isDeleted: integer("is_deleted").notNull().default(0),
    ...timestampColumns,
  },
  (table) => ({
    tenantLayerIdx: index("memory_records_tenant_layer_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.layer,
      table.isDeleted,
    ),
    parentIdx: index("memory_records_parent_idx").on(table.canonicalParentId),
  }),
);

/** 记忆关系有向边表（跨主题/因果/对比等复杂关联关系） */
export const memoryEdges = sqliteTable(
  "memory_edges",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    sourceId: text("source_id")
      .notNull()
      .references(() => memoryRecords.id, { onDelete: "cascade" }),
    targetId: text("target_id")
      .notNull()
      .references(() => memoryRecords.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull(), // "parent_child" | "cross_topic" | "causal" | "contrast"
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    tenantSourceIdx: index("memory_edges_tenant_source_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.sourceId,
    ),
  }),
);

/** 记忆树投影覆盖表（记录用户重命名、调整父节点或锁定行为） */
export const memoryProjectionOverrides = sqliteTable(
  "memory_projection_overrides",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    memoryRecordId: text("memory_record_id")
      .notNull()
      .references(() => memoryRecords.id, { onDelete: "cascade" }),
    overrideType: text("override_type").notNull(), // "rename" | "reparent" | "lock"
    customTitle: text("custom_title"),
    customParentId: text("custom_parent_id"),
    isLocked: integer("is_locked").notNull().default(0),
    ...timestampColumns,
  },
  (table) => ({
    recordIdx: index("memory_projection_overrides_record_idx").on(table.memoryRecordId),
  }),
);
