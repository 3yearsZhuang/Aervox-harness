/**
 * Aervox｜思隅 @aervox/database — 会话与流式协议实体表
 *
 * 规则依据：docs/contracts/STREAMING_PROTOCOL.md + ADR-012
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

/** 会话表 */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    title: text("title").notNull(),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("sessions_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);

/** 对话 Turn 表 */
export const turns = sqliteTable(
  "turns",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    ...tenantColumns,
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status").notNull().default("Created"),
    lastSequence: integer("last_sequence").notNull().default(0),
    error: text("error", { mode: "json" }),
    // MVP 补齐（PRD §8）：请求摘要与生命周期时间点
    requestHash: text("request_hash"),
    acceptedAt: text("accepted_at"),
    cancelledAt: text("cancelled_at"),
    completedAt: text("completed_at"),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdempotencyIdx: uniqueIndex("turns_tenant_idempotency_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.idempotencyKey,
    ),
    sessionIdx: index("turns_session_idx").on(table.sessionId),
  }),
);

/** 消息身份表（身份与版本分离；current_version_id 指向 message_versions.id，应用层维护避免循环外键） */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // "user" | "assistant" | "system"
    currentVersionId: text("current_version_id"), // → message_versions.id
    label: text("label"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
    deletedAt: text("deleted_at"),
  },
  (table) => ({
    sessionIdx: index("messages_session_idx").on(table.sessionId),
  }),
);

/** 消息版本表（支持编辑生成新版本、不可逆删除与脱敏标记） */
export const messageVersions = sqliteTable(
  "message_versions",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    messageId: text("message_id"), // → messages.id（可空；存量数据后迁移，应用层维护）
    ...tenantColumns,
    role: text("role").notNull(), // "user" | "assistant" | "system"
    version: integer("version").notNull().default(1),
    content: text("content").notNull(),
    isRedacted: integer("is_redacted").notNull().default(0),
    supersededAt: text("superseded_at"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    turnVersionIdx: uniqueIndex("message_versions_turn_ver_idx").on(
      table.turnId,
      table.version,
    ),
    tenantIdx: index("message_versions_tenant_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
  }),
);

/** Turn 流式事件表（用于在线 SSE 重放与恢复，非第二份长期真源） */
export const turnStreamEvents = sqliteTable(
  "turn_stream_events",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    attemptId: text("attempt_id"), // → turn_attempts.id（可空）
    ...tenantColumns,
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(), // "message" | "delta" | "done" | "error" | "redacted"
    payloadVersion: integer("payload_version").notNull().default(1),
    data: text("data", { mode: "json" }).notNull(),
    safetyDecision: text("safety_decision"), // "approved" | "blocked" | "redacted" | "pending"
    visibilityRevision: integer("visibility_revision").notNull().default(0),
    occurredAt: text("occurred_at").notNull(),
    committedAt: text("committed_at"),
  },
  (table) => ({
    turnSeqIdx: uniqueIndex("turn_stream_events_turn_seq_idx").on(
      table.turnId,
      table.sequence,
    ),
  }),
);

/** Turn 内部执行尝试（首个可见分段前且无工具副作用时才允许自动重试） */
export const turnAttempts = sqliteTable(
  "turn_attempts",
  {
    id: text("id").primaryKey(),
    turnId: text("turn_id")
      .notNull()
      .references(() => turns.id, { onDelete: "cascade" }),
    attempt: integer("attempt").notNull().default(1),
    leaseId: text("lease_id"),
    fencingToken: integer("fencing_token").notNull().default(0),
    status: text("status").notNull().default("Running"), // "Running" | "Completed" | "Failed" | "Interrupted"
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => ({
    turnAttemptIdx: uniqueIndex("turn_attempts_turn_attempt_idx").on(
      table.turnId,
      table.attempt,
    ),
  }),
);
