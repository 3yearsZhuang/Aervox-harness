/**
 * Aervox｜思隅 @aervox/database — 安全片段表（safe_segments，E2）
 *
 * 规则依据：AVX-HAR-001 §6「分段安全门」、§12.2「安全片段 + TurnStreamEvent + Draft
 * prefix」原子提交。每个已通过安全门、可对客户端可见的文本片段（delta）持久化为
 * 一行，与对应 turn_stream_events 行在同一事务内写入（recordSafeSegmentAtomically）。
 *
 * - `committed`：片段是否已提交为可见前缀（visible-prefix）。中断（visible-prefix-
 *   interrupted）只保留已提交片段，未提交片段不得进入可见前缀；
 * - `stream_event_id`：关联的 turn_stream_events.id（同事务写入，可回溯）。
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";
import { turns } from "./conversations.js";

/** 安全片段（分段安全门的持久化产物；turn 内 sequence 单调） */
export const safeSegments = sqliteTable(
  "safe_segments",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id"), // → turn_attempts.id（可空）
    ...tenantColumns,
    /** 事件流内序号（与 turn_stream_events.sequence 对齐） */
    sequence: integer("sequence").notNull(),
    /** 已提交的安全片段文本（增量 delta） */
    text: text("text").notNull(),
    /** 0/1：是否已提交为可见前缀（visible-prefix） */
    committed: integer("committed").notNull().default(0),
    /** 关联的流事件 id（同事务写入；null=尚未关联） */
    streamEventId: text("stream_event_id"),
    ...timestampColumns,
  },
  (table) => ({
    turnSeqIdx: uniqueIndex("safe_segments_turn_seq_idx").on(table.turnId, table.sequence),
    turnCommittedIdx: index("safe_segments_turn_committed_idx").on(
      table.turnId,
      table.committed,
    ),
    attemptIdx: index("safe_segments_attempt_idx").on(table.attemptId),
    tenantIdx: index("safe_segments_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);

export type SafeSegmentRow = typeof safeSegments.$inferSelect;