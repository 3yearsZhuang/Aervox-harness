/**
 * Aervox｜思隅 @aervox/database — 上下文压缩标记（T-03）
 *
 * 场景：临时→短期整理（上下文压缩）时生成 compaction 标记并落库，按 snapshotId
 * 可溯源被压缩内容、覆盖到的消息锚点与耗时，满足 PRD §7.5「短期记忆必须能查看
 * 由哪些临时记忆整理而来」。
 *
 * 规则约束：
 * - 仅在完整响应持久化后生成标记（匹配数据流「先写后投递」），由调用方保证时序；
 * - 模型更新不得改写已锁定记忆，标记写入后不可就地覆盖（upsert 仅当 snapshotId 未存在）；
 * - 来源内容删除后标记保留 tombstone 形态（summary 允许清空），不得级联删除。
 *
 * 设计依据：reference/baishou-next compaction-marker.ts（AGPLv3，仅借鉴字段形态，
 * 自研实现）。
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";
import { memoryRecords } from "./memories.js";

/** 上下文压缩标记表（T-03） */
export const memoryCompactionMarkers = sqliteTable(
  "memory_compaction_markers",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    memoryId: text("memory_id")
      .notNull()
      .references(() => memoryRecords.id, { onDelete: "cascade" }),
    /** 压缩快照溯源锚（临时→短期的压缩产物标识，跨 Tier 晋升时沿用） */
    snapshotId: text("snapshot_id").notNull(),
    /** 压缩摘要覆盖到的最后一条消息（时间轴锚点，对应 Turn/MessageVersion 区间上界） */
    coveredUpToMessageId: text("covered_up_to_message_id"),
    /** 压缩摘要正文（模型发送的上下文；来源删除后允许置空为 tombstone） */
    summaryText: text("summary_text"),
    /** 触发类型：自动 / 手动 */
    phase: text("phase").notNull().default("auto"), // "auto" | "manual"
    /** 标记状态 */
    status: text("status").notNull().default("completed"), // "completed" | "failed"
    /** 压缩耗时（ms） */
    thoughtDurationMs: integer("thought_duration_ms"),
    summaryDurationMs: integer("summary_duration_ms"),
    ...timestampColumns,
  },
  (table) => ({
    /** 同一记忆同一快照最多一条标记（T-03 幂等约束） */
    memorySnapshotIdx: uniqueIndex("memory_compaction_markers_memory_snapshot_idx").on(
      table.memoryId,
      table.snapshotId,
    ),
    tenantIdx: index("memory_compaction_markers_tenant_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
  }),
);