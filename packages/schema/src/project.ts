/**
 * Aervox｜思隅 @aervox/schema — 项目实体表（CR-048 / W3）
 */
import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { timestampColumns } from "./common.js";

/** 项目表 */
export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    color: text("color"),
    icon: text("icon"),
    archivedAt: text("archived_at"),
    ...timestampColumns,
  },
  (table) => ({
    nameIdx: index("projects_name_idx").on(table.name),
  }),
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
