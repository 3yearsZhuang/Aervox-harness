/**
 * Aervox｜思隅 @aervox/database — 质量反馈实体表
 *
 * 规则依据：docs/reference/PRD.md §8 数据模型（Feedback）
 */
import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { tenantColumns } from "./common.js";

/** 质量反馈（对消息/日记/记忆/题目/社区内容）；反馈操作者与被处理数据主体分离 */
export const feedback = sqliteTable(
  "feedback",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    actorId: text("actor_id").notNull(), // 操作者（可不同于数据主体）
    subjectType: text("subject_type").notNull(), // "message" | "diary" | "memory" | "question" | "community"
    subjectId: text("subject_id").notNull(),
    type: text("type").notNull(), // "positive" | "negative" | "inaccurate" | "unsafe" | "confusing" | "other"
    note: text("note"),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    subjectIdx: index("feedback_subject_idx").on(table.subjectType, table.subjectId),
    tenantIdx: index("feedback_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);
