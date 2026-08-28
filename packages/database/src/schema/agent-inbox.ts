/**
 * Aervox｜思隅 @aervox/database — Agent 收件箱（agent_inbox_items）
 *
 * 规则依据：ADR-017「冻结 ContextManifest / ModelRun / AgentStep 关联与 Inbox 数据模型」
 * 与 AVX-HAR-001 §7.2 AgentInboxItem：
 * - followup / steer / inject 三种受控收件箱条目，均绑定租户 + 目标边界 + 来源 actor + 幂等键 + 状态；
 * - 消费采用 claim/ack，崩溃后安全重放；`steer` 只作用于下一 Step，不能改写已提交事件；
 * - 外部插件不能直接修改 Session 日志，只能提交受限 inbox command。
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

export const agentInboxItems = sqliteTable(
  "agent_inbox_items",
  {
    id: text("id").primaryKey(),
    /** 幂等键（来源 + 事件去重；claims 依赖） */
    idempotencyKey: text("idempotency_key").notNull(),
    sessionId: text("session_id").notNull(),
    /** 消费目标 Attempt（next-turn = null；next-step 定位） */
    attemptId: text("attempt_id"),
    stepId: text("step_id"),
    /** followup / steer / inject */
    type: text("type").notNull(),
    /** 顺序（同目标边界内单调） */
    orderingSeq: integer("ordering_seq").notNull().default(0),
    /** 来源 actor（user / agent / plugin） */
    sourceActor: text("source_actor").notNull(),
    /** 内容载荷（compact 编码，含来源与用途标注） */
    payloadJson: text("payload_json", { mode: "json" }).notNull(),
    /** pending / claimed / acknowledged / expired */
    status: text("status").notNull().default("pending"),
    /** next-turn / next-step（= §7.2 消费边界） */
    consumeBoundary: text("consume_boundary").notNull(),
    claimedAt: text("claimed_at"),
    ackedAt: text("acked_at"),
    expiresAt: text("expires_at"),
    ...tenantColumns,
    ...timestampColumns,
  },
  (table) => ({
    tenantSessionIdx: index("agent_inbox_tenant_session_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.sessionId,
    ),
    statusIdx: index("agent_inbox_status_idx").on(table.status),
    tenantIdempotencyIdx: uniqueIndex("agent_inbox_tenant_idempotency_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.idempotencyKey,
    ),
  }),
);