/**
 * Aervox｜思隅 @aervox/database — Embedding 独立存储（T-05）
 *
 * 场景：向量数据不塞进业务表（memory_records），独立成 memory_embeddings：
 * 换 embedding 模型不迁移业务表，SQLite 侧先行落地，后续切 pgvector 仅替换
 * 仓储实现（对照 AST-02 的 Port 形态：批量/重试/进度回调 + retrieve 语义）。
 *
 * 与 embedding_indexes 的关系：embedding_indexes 记录「索引任务/版本」状态，
 * 本表是「向量数据本体」（含 dimension/modelId/sourceCreatedAt，参考 baishou-next
 * schema/vectors.ts 的字段形态，自研实现）。
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";
import { memoryRecords } from "./memories.js";

/** 记忆向量存储表（T-05） */
export const memoryEmbeddings = sqliteTable(
  "memory_embeddings",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    memoryId: text("memory_id")
      .notNull()
      .references(() => memoryRecords.id, { onDelete: "cascade" }),
    /** 向量维度；换模型时按 model_id 区分批次，不覆盖旧向量 */
    dimension: integer("dimension").notNull(),
    /** 生成向量的 embedding 模型标识 */
    modelId: text("model_id").notNull(),
    /** 向量数据（JSON number[]；SQLite 无原生向量扩展时行扫描 + JS 余弦） */
    embeddingJson: text("embedding_json").notNull(),
    /** 源记忆的 createdAt（用于按时间窗口过滤与批量迁移断点） */
    sourceCreatedAt: text("source_created_at"),
    /** 索引版本（配合 embedding_indexes.index_version） */
    indexVersion: integer("index_version").notNull().default(1),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("memory_embeddings_tenant_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
    memoryIdx: index("memory_embeddings_memory_idx").on(table.memoryId),
    modelIdx: index("memory_embeddings_model_idx").on(table.modelId),
  }),
);