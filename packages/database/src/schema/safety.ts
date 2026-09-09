/**
 * Aervox｜思隅 @aervox/database — 安全事件实体表
 *
 * 规则依据：docs/reference/PRD.md §8 数据模型（SafetyIncident）
 * 访问受限：不写入普通记忆或分析明细。
 */
import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";

/** 安全事件最小化记录 */
export const safetyIncidents = sqliteTable(
  "safety_incidents",
  {
    id: text("id").primaryKey(),
    category: text("category").notNull(), // "self_harm" | "harm_to_others" | "harmful_content" | "privacy" | "manipulation"
    severity: text("severity").notNull(), // "low" | "medium" | "high" | "critical"
    disposition: text("disposition").notNull(), // "blocked" | "escalated" | "logged" | "monitored"
    policyVersion: text("policy_version").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
);
