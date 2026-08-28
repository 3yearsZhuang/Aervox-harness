/**
 * Aervox｜思隅 @aervox/database — 用户偏好 Schema（CAP-010 人格问卷与基础偏好）
 *
 * 覆盖：FR-PER-001（语气/主动程度/称呼/提醒节奏）、FR-PER-002（修改与重置）
 * 每租户一行，neut 默认值由 API 层保证。
 */
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

export const personaPreferences = sqliteTable("persona_preferences", {
  ...tenantColumns,
  id: text("id").primaryKey(),

  /** FR-PER-001：语气 — "friendly" | "neutral" | "formal" */
  tone: text("tone", { enum: ["friendly", "neutral", "formal"] })
    .notNull()
    .default("neutral"),
  /** FR-PER-001：主动程度 — "low" | "medium" | "high" */
  proactiveness: text("proactiveness", { enum: ["low", "medium", "high"] })
    .notNull()
    .default("medium"),
  /** FR-PER-001：称呼 — "casual" | "formal" | "none" */
  addressForm: text("address_form", { enum: ["casual", "formal", "none"] })
    .notNull()
    .default("none"),
  /** FR-PER-001：提醒节奏 — "gentle" | "moderate" | "frequent" */
  reminderCadence: text("reminder_cadence", { enum: ["gentle", "moderate", "frequent"] })
    .notNull()
    .default("moderate"),

  /** FR-PER-002：偏好版本号，每次修改递增 */
  version: integer("version").notNull().default(1),

  /** FR-PER-002：问卷是否已跳过（跳过时使用中性默认值） */
  skipped: integer("skipped", { mode: "boolean" }).notNull().default(false),

  ...timestampColumns,
});