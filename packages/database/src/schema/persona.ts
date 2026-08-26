/**
 * Aervox｜思隅 @aervox/database — 人格与上下文快照实体表（CAP-019/CAP-020）
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

/** 人格（多人格模板，CAP-019）；删除采用归档而非物理删除 */
export const personas = sqliteTable(
  "personas",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    source: text("source").notNull().default("user_created"), // "builtin" | "user_created" | "imported"
    status: text("status").notNull().default("active"), // "active" | "archived"
    currentRevisionId: text("current_revision_id").notNull(),
    ...timestampColumns,
  },
  (table) => ({
    tenantIdx: index("personas_tenant_idx").on(table.workspaceId, table.subjectUserId),
  }),
);

/** 人格不可变修订（配置 JSON + checksum；编辑生成新修订，不物理覆盖） */
export const personaRevisions = sqliteTable(
  "persona_revisions",
  {
    id: text("id").primaryKey(),
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    config: text("config", { mode: "json" }).notNull(), // PersonaRevisionConfig
    checksum: text("checksum").notNull(),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    personaRevisionIdx: uniqueIndex("persona_revisions_persona_revision_idx").on(
      table.personaId,
      table.revision,
    ),
    personaIdx: index("persona_revisions_persona_idx").on(table.personaId),
  }),
);

/** 当前激活人格（每租户一条条件唯一，通过 upsert 维护） */
export const personaSelections = sqliteTable(
  "persona_selections",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    personaId: text("persona_id")
      .notNull()
      .references(() => personas.id, { onDelete: "cascade" }),
    revisionId: text("revision_id").notNull(),
    selectedAt: text("selected_at").notNull(),
    ...timestampColumns,
  },
  (table) => ({
    tenantUniqueIdx: uniqueIndex("persona_selections_tenant_unique_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
  }),
);

/** Turn 级 PersonaContextSnapshot（审计/重放；不含完整敏感 Prompt） */
export const personaTurnContexts = sqliteTable(
  "persona_turn_contexts",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    turnId: text("turn_id").notNull(),
    personaId: text("persona_id").notNull(),
    revisionId: text("revision_id").notNull(),
    revisionChecksum: text("revision_checksum").notNull(),
    promptChecksum: text("prompt_checksum").notNull(),
    skillChecksums: text("skill_checksums", { mode: "json" }).notNull().default([]),
    mcpToolIds: text("mcp_tool_ids", { mode: "json" }).notNull().default([]),
    voice: text("voice", { mode: "json" }),
    createdAt: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
  },
  (table) => ({
    tenantTurnIdx: uniqueIndex("persona_turn_contexts_tenant_turn_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.turnId,
    ),
    tenantIdx: index("persona_turn_contexts_tenant_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
  }),
);
