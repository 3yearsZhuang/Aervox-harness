/**
 * Aervox｜思隅 @aervox/schema — 工作区技能导入表
 *
 * 本表在 DDL 已存在但此前缺少 Drizzle 声明，补齐以消除 schema-index-parity 豁免。
 */
import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { timestampColumns } from "./common.js";

/** 工作区技能文件导入记录（SKILL.md 解析后的结构化表示） */
export const workspaceSkills = sqliteTable(
  "workspace_skills",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    license: text("license"),
    compatibility: text("compatibility"),
    metadata: text("metadata"),
    allowedTools: text("allowed_tools"),
    source: text("source").notNull().default("workspace"),
    version: integer("version").notNull().default(1),
    checksum: text("checksum").notNull(),
    enabled: integer("enabled").notNull().default(1),
    valid: integer("valid").notNull().default(1),
    validationErrors: text("validation_errors").notNull().default("[]"),
    filesJson: text("files_json").notNull(),
    skillMarkdown: text("skill_markdown").notNull(),
    importedAt: text("imported_at").notNull(),
    ...timestampColumns,
  },
  (table) => ({
    localNameUniqueIdx: uniqueIndex("workspace_skills_local_name_unique_idx").on(
      table.name,
    ),
  }),
);
