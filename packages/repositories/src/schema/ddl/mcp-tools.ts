/**
 * Aervox｜思隅 @aervox/repositories — mcp-tools 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createMcpToolsTables(client: Client): Promise<void> {
  await client.execute(`
      CREATE TABLE IF NOT EXISTS mcp_tools (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        server_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        input_schema TEXT,
        scopes TEXT NOT NULL DEFAULT '[]',
        healthy INTEGER NOT NULL DEFAULT 1,
        authorized INTEGER NOT NULL DEFAULT 1,
        revoked INTEGER NOT NULL DEFAULT 0,
        kill_switch INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS mcp_tools_tenant_server_name_idx ON mcp_tools(workspace_id, subject_user_id, server_id, name);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS mcp_tools_tenant_idx ON mcp_tools(workspace_id, subject_user_id);
    `);
}
