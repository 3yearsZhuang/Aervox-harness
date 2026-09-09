/**
 * Aervox｜思隅 @aervox/repositories — mcp 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createMcpTables(client: Client): Promise<void> {
  // 17.1 MCP 服务器连接配置（系统级，无租户列；同步出的工具落 tool_registrations）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        transport TEXT NOT NULL DEFAULT 'streamable_http',
        endpoint_url TEXT NOT NULL,
        auth_type TEXT NOT NULL DEFAULT 'bearer',
        token TEXT,
        enabled INTEGER NOT NULL DEFAULT 0,
        is_preset INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'disconnected',
        last_sync_at TEXT,
        last_error TEXT,
        tool_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
}
