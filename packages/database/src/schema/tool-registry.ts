/**
 * Aervox｜思隅 @aervox/database — T-04 工具注册表 + AST-04 门控条件
 *
 * 规则依据：docs/explanation/reference-design-transfer.md §3.4 T-04 工具注册表与主动记忆工具
 * 与 §4.7 AST-04 插件元数据与工具配置门控。
 *
 * 设计要点：
 * - tool_registrations 为系统级表（无租户列），工具注册与租户无关；
 * - gating_conditions_json 存 AST-04 条件门控数组（equals/in/truthy/custom）；
 * - enabled = 0 对应 disabledToolIds，运行时按 enabled + gating 过滤导出；
 * - PET-05 safety_level 标记只读白名单（read_only 可被 AI 自主调用）。
 */
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { timestampColumns } from "./common.js";

/** T-04 工具注册表（系统级，无租户列） */
export const toolRegistrations = sqliteTable(
  "tool_registrations",
  {
    id: text("id").primaryKey(), // 工具标识（如 "aervox_memory_store"）
    name: text("name").notNull(), // 面向 AI 的工具名称
    description: text("description").notNull(),
    category: text("category").notNull(), // memory/search/learning/diary/system/external
    /** PET-05 安全级别：read_only / write_with_approval / privileged */
    safetyLevel: text("safety_level").notNull().default("write_with_approval"),
    /** 工具所需权限声明（JSON 数组，对应 plugin_grants.permission） */
    requiredPermissionsJson: text("required_permissions_json", { mode: "json" }),
    /** MCP tool inputSchema（JSON） */
    inputSchemaJson: text("input_schema_json", { mode: "json" }),
    /** 是否为内置工具（内置不可卸载） */
    builtin: integer("builtin").notNull().default(0),
    /** 关联插件 ID（非内置时必填） */
    pluginId: text("plugin_id"),
    /** 是否启用（0 = disabledToolIds） */
    enabled: integer("enabled").notNull().default(1),
    /** AST-04 条件门控（JSON 数组） */
    gatingConditionsJson: text("gating_conditions_json", { mode: "json" }),
    /** 注册顺序（排序用） */
    priority: integer("priority").notNull().default(0),
    ...timestampColumns,
  },
  (table) => ({
    idIdx: uniqueIndex("tool_registrations_id_idx").on(table.id),
    pluginIdx: index("tool_registrations_plugin_idx").on(table.pluginId),
    categoryEnabledIdx: index("tool_registrations_category_enabled_idx").on(
      table.category,
      table.enabled,
    ),
  }),
);
