/**
 * Aervox｜思隅 @aervox/repositories — tool-registry 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";
import { addColumnIfMissing } from "./common.js";

export async function createToolRegistryTables(client: Client): Promise<void> {
  // 17. T-04 工具注册表 + AST-04 条件门控（系统级，无租户列）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS tool_registrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        category TEXT NOT NULL,
        safety_level TEXT NOT NULL DEFAULT 'write_with_approval',
        replay TEXT,
        required_permissions_json TEXT,
        input_schema_json TEXT,
        builtin INTEGER NOT NULL DEFAULT 0,
        plugin_id TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        gating_conditions_json TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS tool_registrations_plugin_idx ON tool_registrations(plugin_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS tool_registrations_category_enabled_idx ON tool_registrations(category, enabled);
    `);
  // B3：工具结果未知恢复复议声明（never/safe；未声明 = fail-closed 收敛）；旧库幂等补齐
    await addColumnIfMissing(client, "tool_registrations", "replay", "replay TEXT");
}
