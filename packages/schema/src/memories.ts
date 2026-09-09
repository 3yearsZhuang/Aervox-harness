/**
 * Aervox｜思隅 @aervox/database — 记忆与记忆树实体表
 *
 * 规则依据：docs/reference/adr/ADR-007-memory-tree-projection.md + SRS BR-MEM-001/003 + PRD §8
 *
 * P1（R2）迁移重构：系统记忆树投影独立为 memory_nodes；memory_edges / memory_projection_overrides
 * 由记录级（memory_records）迁移到节点级（memory_nodes），新增 memory_edge_evidence 证据关联。
 * memory_records.canonical_parent_id 保留为记录层内联（旧适配器兼容），投影层以 memory_nodes 为准。
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";
import { memoryRevisions } from "./provenance.js";

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
    // MVP 补齐（PRD §8）：召回与历史保留独立、敏感分级与校验状态
    currentRevisionId: text("current_revision_id"), // → memory_revisions.id（应用层维护，避免循环外键）
    sensitivityClass: text("sensitivity_class").notNull().default("normal"), // "public" | "normal" | "sensitive" | "restricted"
    aiRecallUntil: text("ai_recall_until"), // 召回期限
    userRetentionUntil: text("user_retention_until"), // 历史保留期限
    verificationStatus: text("verification_status").notNull().default("unverified"), // "unverified" | "verified" | "conflicted" | "invalidated"
    // PET-02 记忆条目字段对照（参考 Petra MemoryEntry 字段形态，自研）：
    // source 区分「用户自述 / AI 推断」：user_said 可置信，ai_inferred 默认降入候选（verificationStatus 联动）
    source: text("source").notNull().default("user_said"), // "user_said" | "ai_inferred"
    // 记忆类别（identity/preference/habit/schedule/relationship/event/other）
    category: text("category").notNull().default("other"),
    // 关键词（JSON string[]；支撑记忆树投影与检索归类）
    keywordsJson: text("keywords_json"),
    // 最近一次被引用时间（支撑召回窗口淘汰，替换由上层维护）
    lastUsedAt: text("last_used_at"),
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

/** 系统记忆树投影节点（P1；可由有效长期记忆重建，不复制内容） */
export const memoryNodes = sqliteTable(
  "memory_nodes",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    canonicalParentId: text("canonical_parent_id"), // 自引用 → memory_nodes.id（投影树父节点）
    label: text("label").notNull(),
    nodeType: text("node_type").notNull().default("concept"), // "concept" | "topic" | "goal" | "relation"
    confidence: integer("confidence").notNull().default(0),
    status: text("status").notNull().default("active"), // "active" | "draft" | "superseded"
    projectionVersion: integer("projection_version").notNull().default(1),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("memory_nodes_tenant_idx").on(table.workspaceId, table.subjectUserId),
    parentIdx: index("memory_nodes_parent_idx").on(table.canonicalParentId),
  }),
);

/** 记忆关系有向边表（节点级；层级边与跨主题关系） */
export const memoryEdges = sqliteTable(
  "memory_edges",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    fromNodeId: text("from_node_id")
      .notNull()
      .references(() => memoryNodes.id, { onDelete: "cascade" }),
    toNodeId: text("to_node_id")
      .notNull()
      .references(() => memoryNodes.id, { onDelete: "cascade" }),
    relationType: text("relation_type").notNull(), // "parent_child" | "cross_topic" | "causal" | "contrast"
    confidence: integer("confidence").notNull().default(0),
    visibilityScope: text("visibility_scope").notNull().default("private"), // "private" | "shared" | "public"
    status: text("status").notNull().default("active"), // "active" | "superseded"
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    tenantFromIdx: index("memory_edges_tenant_from_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.fromNodeId,
    ),
  }),
);

/** 关系边 → 长期记忆证据外键（P1） */
export const memoryEdgeEvidence = sqliteTable(
  "memory_edge_evidence",
  {
    id: text("id").primaryKey(),
    edgeId: text("edge_id")
      .notNull()
      .references(() => memoryEdges.id, { onDelete: "cascade" }),
    memoryRevisionId: text("memory_revision_id")
      .notNull()
      .references(() => memoryRevisions.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"), // "active" | "superseded"
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    edgeIdx: index("memory_edge_evidence_edge_idx").on(table.edgeId),
  }),
);

/** 记忆树投影覆盖表（节点级；记录用户锁定/改名/父节点调整，作为投影重建的权威输入） */
export const memoryProjectionOverrides = sqliteTable(
  "memory_projection_overrides",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    nodeId: text("node_id")
      .notNull()
      .references(() => memoryNodes.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(), // "rename" | "reparent" | "lock" | "unlock"
    label: text("label"),
    parentNodeId: text("parent_node_id"),
    actorId: text("actor_id").notNull(),
    status: text("status").notNull().default("active"), // "active" | "superseded"
    ...timestampColumns,
  },
  (table) => ({
    nodeIdx: index("memory_projection_overrides_node_idx").on(table.nodeId),
  }),
);

/** 记忆算法规则版本（P1；系统级，无租户列；压缩/晋升/衰减/投影规则） */
export const memoryAlgorithms = sqliteTable(
  "memory_algorithms",
  {
    id: text("id").primaryKey(),
    stage: text("stage").notNull(), // "ephemeral_to_short" | "short_to_long" | "long_to_projection" | "decay"
    schemaVersion: integer("schema_version").notNull().default(1),
    promptVersionId: text("prompt_version_id"), // → prompt_versions.id
    thresholds: text("thresholds", { mode: "json" }),
    status: text("status").notNull().default("draft"), // "draft" | "active" | "retired"
    approvedAt: text("approved_at"),
    ...timestampColumns,
  },
  (table) => ({
    stageSchemaIdx: index("memory_algorithms_stage_schema_idx").on(table.stage, table.schemaVersion),
  }),
);
