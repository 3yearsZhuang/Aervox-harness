/**
 * Aervox｜思隅 @aervox/database — MCP 服务器连接配置
 *
 * 规则依据：docs/explanation/reference-design-transfer.md §3.4 T-04 工具注册表与
 * docs/reference/capability-composition.md（外部能力经 adapter 形态接入，不拥有核心业务数据）。
 *
 * 设计要点：
 * - mcp_servers 为系统级表（无租户列），与 tool_registrations 对齐：桌面单用户形态下
 *   服务器连接配置全租户共享，同步出的远程工具同样落系统级注册表；
 * - 只存「如何连接」（transport / endpoint / 鉴权），不存工具元数据——同步出的工具
 *   以 `mcp__<serverId>__<toolName>` 命名落 tool_registrations（category=external）；
 * - token 为本地敏感凭据：仅存本地 SQLite，API 一律不回传原文（CR-004「不导出 MCP 凭据」）。
 */
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { timestampColumns } from "./common.js";

/** MCP 服务器连接配置（系统级，无租户列） */
export const mcpServers = sqliteTable("mcp_servers", {
  /** 服务器标识（如预设 "mcd-mcp"；同时作为工具命名空间） */
  id: text("id").primaryKey(),
  /** 展示名（如 "麦当劳 MCP"） */
  name: text("name").notNull(),
  /** 传输协议：streamable_http / sse（预留） */
  transport: text("transport").notNull().default("streamable_http"),
  /** 接入端点 URL */
  endpointUrl: text("endpoint_url").notNull(),
  /** 鉴权方式：bearer / none */
  authType: text("auth_type").notNull().default("bearer"),
  /** 鉴权凭据（如 Bearer Token；本地敏感数据，API 不回传原文） */
  token: text("token"),
  /** 是否启用（断开 = 0，同时注销其同步工具） */
  enabled: integer("enabled").notNull().default(0),
  /** 是否来自预设清单（预设不可删除，只可断开） */
  isPreset: integer("is_preset").notNull().default(0),
  /** 连接状态：disconnected / connected / error */
  status: text("status").notNull().default("disconnected"),
  /** 最近一次工具同步时间（ISO8601） */
  lastSyncAt: text("last_sync_at"),
  /** 最近一次错误信息（连接/同步失败原因） */
  lastError: text("last_error"),
  /** 最近一次同步到的工具数量 */
  toolCount: integer("tool_count").notNull().default(0),
  ...timestampColumns,
});

export type McpServerRow = typeof mcpServers.$inferSelect;
export type McpServerInsert = typeof mcpServers.$inferInsert;
