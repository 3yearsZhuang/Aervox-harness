/**
 * Aervox｜思隅 @aervox/database — 埋点事件实体表
 *
 * 规则依据：docs/reference/PRD.md §8 数据模型（AnalyticsEvent）
 * 注意：analyticsSubjectId 使用伪名化标识，不保存无必要正文。
 */
import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { tenantColumns } from "./common.js";

/** 埋点事件（事件专属 schema；业务 ID 按上下文选填） */
export const analyticsEvents = sqliteTable(
  "analytics_events",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    eventName: text("event_name").notNull(),
    eventSchemaVersion: integer("event_schema_version").notNull().default(1),
    occurredAt: text("occurred_at").notNull(),
    analyticsSubjectId: text("analytics_subject_id").notNull(), // 伪名化标识
    context: text("context", { mode: "json" }), // 按事件 schema 的上下文
    privacyClass: text("privacy_class").notNull().default("normal"), // "public" | "normal" | "sensitive"
  },
  (table) => ({
    tenantEventIdx: index("analytics_events_tenant_event_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.eventName,
      table.occurredAt,
    ),
    subjectIdx: index("analytics_events_subject_idx").on(table.analyticsSubjectId),
  }),
);
