/**
 * Aervox｜思隅 @aervox/database — 挂起提问会话（pending_user_questions）
 *
 * 缺陷 C：UserQuestionCoordinator 的挂起提问原先只在进程内存（Promise + timer），
 * 进程重启/多实例后内存态丢失，客户端提交回答必然 409，Turn 永久悬挂。
 * 本表持久化挂起提问的真实状态（唯一真源）：
 * - turnId 主键（一个 Turn 至多一个挂起提问）；
 * - expiresAt = createdAt + timeoutMs：超时语义以持久化时间为准，崩溃后仍正确；
 * - Questions 存 JSON；answered 后删除该行（事件流 user_question_answered 为留痕）。
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { tenantColumns } from "./common.js";

export const pendingUserQuestions = sqliteTable(
  "pending_user_questions",
  {
    turnId: text("turn_id").primaryKey(),
    attemptId: text("attempt_id").notNull(),
    step: integer("step").notNull(),
    /** 模型提出的问题清单（JSON 编码 AskUserQuestionItem[]） */
    questionsJson: text("questions_json", { mode: "json" }).notNull().$type<unknown>(),
    timeoutMs: integer("timeout_ms").notNull(),
    /** 超时语义唯一真源：createdAt + timeoutMs */
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
    ...tenantColumns,
  },
  (table) => ({
    tenantIdx: index("pending_user_questions_tenant_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
    tenantExpiresIdx: index("pending_user_questions_tenant_expires_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.expiresAt,
    ),
  }),
);

export type PendingUserQuestionRow = typeof pendingUserQuestions.$inferSelect;