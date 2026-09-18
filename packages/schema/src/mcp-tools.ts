/**
 * Aervox｜思隅 @aervox/schema — MCP 工具同步表
 *
 * 本表在 DDL 已存在但此前缺少 Drizzle 声明，补齐以消除 schema-index-parity 豁免。
 */
import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
import { timestampColumns } from "./common.js";

/** MCP 工具同步记录（每个 MCP Server 注册的工具在此维护健康/授权/熔断状态） */
export const mcpTools = sqliteTable(
  "mcp_tools",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    inputSchema: text("input_schema"),
    scopes: text("scopes").notNull().default("[]"),
    healthy: integer("healthy").notNull().default(1),
    authorized: integer("authorized").notNull().default(1),
    revoked: integer("revoked").notNull().default(0),
    killSwitch: integer("kill_switch").notNull().default(0),
    ...timestampColumns,
  },
  (table) => ({
    localServerNameUniqueIdx: uniqueIndex("mcp_tools_local_server_name_idx").on(
      table.serverId,
      table.name,
    ),
  }),
);
