/**
 * CR-032 旧库升级回归：proactive_trigger_rules 旧形态（无 plugin_id）经
 * initDatabaseSchema 幂等补列后，归属索引才能创建——补列必须先于索引。
 */
import { describe, expect, it } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema } from "@aervox/repositories";

describe("proactive intelligence schema upgrade (CR-032)", () => {
  it("adds plugin_id column and ownership index to a pre-CR-032 database", async () => {
    const {db, client, cleanup} = await createInMemoryDatabase({ empty: true });
    try {
      // 1) 先构造旧形态表（无 plugin_id），模拟 CR-032 之前的存量库
      await client.execute(`
        CREATE TABLE proactive_trigger_rules (
          id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, name TEXT NOT NULL, trigger_type TEXT NOT NULL,
          condition_json TEXT NOT NULL DEFAULT '{}', action_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 0,
          cooldown_seconds INTEGER NOT NULL DEFAULT 3600, quiet_hours_json TEXT NOT NULL DEFAULT '{}',
          last_triggered_at TEXT, processing_boundary TEXT NOT NULL DEFAULT 'local_only',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      `);
      await client.execute(`CREATE INDEX IF NOT EXISTS proactive_trigger_rule_local_enabled_idx ON proactive_trigger_rules(enabled);`);

      // 2) 幂等初始化应先补列再建索引（顺序颠倒会在此处抛 no such column）
      await initDatabaseSchema(client);

      const columns = await client.execute(`PRAGMA table_info(proactive_trigger_rules)`);
      const names = columns.rows.map((row) => String(row.name));
      expect(names).toContain("plugin_id");

      const indexes = await client.execute(`PRAGMA index_list(proactive_trigger_rules)`);
      const indexNames = indexes.rows.map((row) => String(row.name));
      expect(indexNames).toContain("proactive_trigger_rules_plugin_idx");

      // 3) 归属索引可用：按 plugin_id 查询可执行
      await db.run(`INSERT INTO proactive_trigger_rules (id, revision_id, name, trigger_type, enabled, created_at, updated_at)
        VALUES ('rule_upgrade_probe', 'rev_probe', 'probe', 'system_state', 0, '2026-09-13T00:00:00.000Z', '2026-09-13T00:00:00.000Z')`);
      const probe = await client.execute(`SELECT id FROM proactive_trigger_rules WHERE plugin_id IS NULL`);
      expect(probe.rows.length).toBeGreaterThanOrEqual(1);
    } finally {
      await cleanup();
    }
  });
});
