/**
 * Aervox｜思隅 @aervox/database — 插件 Config 与 Page 持久化（CAP-020 扩展）
 *
 * 规则依据：docs/reference/plugin-config-and-pages.md（CR-006）。
 * - plugin_configs：工作区+用户作用域的插件配置值（不含 secret 明文）；
 * - plugin_config_secrets：secret 字段的宿主存储（默认本地实现不对外回显；生产注入加密 Store）；
 * - plugin_pages：插件 Page 元数据（系统级，生命周期归插件）。
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { tenantColumns, timestampColumns } from "./common.js";

/** 插件配置快照（租户级；secret 只记录已配置状态，不存明文） */
export const pluginConfigs = sqliteTable(
  "plugin_configs",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    pluginId: text("plugin_id").notNull(),
    /** 非敏感配置值（JSON 对象） */
    valuesJson: text("values_json", { mode: "json" }).notNull(),
    /** 已配置 secret 字段键列表（配合 secret store） */
    secretKeysJson: text("secret_keys_json", { mode: "json" }).notNull(),
    /** 生效的 Schema 版本 */
    schemaVersion: integer("schema_version").notNull().default(1),
    /** 乐观并发版本号（CAS） */
    revision: integer("revision").notNull().default(0),
    /** Schema 升级后移除/不兼容字段的原值（不立即丢弃） */
    orphanedValuesJson: text("orphaned_values_json", { mode: "json" }),
    ...timestampColumns,
  },
  (table) => ({
    tenantPluginIdx: uniqueIndex("plugin_configs_tenant_plugin_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.pluginId,
    ),
  }),
);

/** 插件 secret 字段（本地默认实现保存值；生产必须注入加密 SecretStore Port） */
export const pluginConfigSecrets = sqliteTable(
  "plugin_config_secrets",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    pluginId: text("plugin_id").notNull(),
    fieldKey: text("field_key").notNull(),
    /** 加密后的值/引用（本地实现直接存值，接口永不回显） */
    valueJson: text("value_json", { mode: "json" }).notNull(),
    configured: integer("configured").notNull().default(1),
    ...timestampColumns,
  },
  (table) => ({
    tenantPluginFieldIdx: uniqueIndex("plugin_config_secrets_tenant_plugin_field_idx").on(
      table.workspaceId,
      table.subjectUserId,
      table.pluginId,
      table.fieldKey,
    ),
  }),
);

/** 插件 Page 元数据（系统级，无租户列；生命周期归插件） */
export const pluginPages = sqliteTable(
  "plugin_pages",
  {
    id: text("id").primaryKey(),
    pluginId: text("plugin_id").notNull(),
    pageId: text("page_id").notNull(),
    title: text("title", { mode: "json" }).notNull(),
    description: text("description", { mode: "json" }),
    entry: text("entry").notNull(),
    capabilitiesJson: text("capabilities_json", { mode: "json" }).notNull(),
    checksum: text("checksum"),
    ...timestampColumns,
  },
  (table) => ({
    pluginPageIdx: uniqueIndex("plugin_pages_plugin_page_idx").on(table.pluginId, table.pageId),
    pluginIdx: index("plugin_pages_plugin_idx").on(table.pluginId),
  }),
);
