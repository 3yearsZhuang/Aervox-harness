/**
 * Aervox｜思隅 @aervox/database — Agent 可观测性审计日志（缺陷5）
 *
 * 系统级审计（无租户列）：可跨租户检索 Agent 运行审计（turn 完成 / 审批 / 租约事件等）。
 * 字段对齐 @aervox/observability 的 AuditEntry；payload 以 JSON 文本存储。
 */
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  /** 内部领域事件名（agent.turn.completed 等） */
  eventType: text("event_type").notNull(),
  /** 触发者（agent-host / user-id 等） */
  actorId: text("actor_id").notNull(),
  /** 人事可读动作（approve_tool / cancel_turn / lease_expired） */
  action: text("action").notNull(),
  /** 受影响资源维度（turnId / attemptId / sessionId） */
  scope: text("scope").notNull(),
  /** 关联证据（execution 行 id / outbox id） */
  evidenceRef: text("evidence_ref"),
  /** 结构化载荷 JSON 文本 */
  payload: text("payload"),
  createdAt: text("created_at").notNull(),
});