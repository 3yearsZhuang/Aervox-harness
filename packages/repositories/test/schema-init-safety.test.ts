import { describe, it, expect } from "vitest";
import { createInMemoryDatabase, initDatabaseSchema } from "../src/index.js";
import { addColumnIfMissing } from "../src/schema/ddl/common.js";

describe("Schema 初始化与列迁移安全 (Issue 4 & 5)", () => {
  it("addColumnIfMissing: 正常添加列并幂等处理已存在的 duplicate column", async () => {
    const { client, cleanup } = await createInMemoryDatabase();
    try {
      await client.execute(`CREATE TABLE test_table (id TEXT PRIMARY KEY);`);

      // 首次添加
      await addColumnIfMissing(client, "test_table", "new_col", "new_col TEXT");
      const info1 = await client.execute(`PRAGMA table_info(test_table)`);
      expect(info1.rows.some((r) => r.name === "new_col")).toBe(true);

      // 二次添加相同列名（内部或底层 duplicate 场景）：幂等不抛错
      await expect(
        addColumnIfMissing(client, "test_table", "new_col", "new_col TEXT"),
      ).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("addColumnIfMissing: 遇到非 duplicate column 异常（如语法错误、表不存在）必须向外抛出而不是静默吞掉", async () => {
    const { client, cleanup } = await createInMemoryDatabase();
    try {
      // 语法错误定义
      await client.execute(`CREATE TABLE test_table_syntax (id TEXT PRIMARY KEY);`);
      await expect(
        addColumnIfMissing(client, "test_table_syntax", "bad_col", "bad_col INVALID_SQL_TYPE %%%"),
      ).rejects.toThrow();

      // 表不存在
      await expect(
        addColumnIfMissing(client, "non_existent_table", "foo", "foo TEXT"),
      ).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });

  it("initDatabaseSchema: 两个独立 Client 并发初始化时，列缓存互不污染且支持多次幂等重入", async () => {
    const dbA = await createInMemoryDatabase();
    const dbB = await createInMemoryDatabase();
    try {
      // 并发初始化两个数据库
      await Promise.all([
        initDatabaseSchema(dbA.client),
        initDatabaseSchema(dbB.client),
      ]);

      // 再次重复调用同一 client，验证幂等
      await initDatabaseSchema(dbA.client);

      const tableRowsA = await dbA.client.execute(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='plugins'`,
      );
      const tableRowsB = await dbB.client.execute(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='plugins'`,
      );
      expect(tableRowsA.rows.length).toBe(1);
      expect(tableRowsB.rows.length).toBe(1);
    } finally {
      await dbA.cleanup();
      await dbB.cleanup();
    }
  });

  it("initDatabaseSchema: 高频 Worker 扫描索引按旧库重入方式补齐", async () => {
    const { client, cleanup } = await createInMemoryDatabase();
    try {
      await initDatabaseSchema(client);

      const rows = await client.execute(`
        SELECT name
        FROM sqlite_master
        WHERE type = 'index'
          AND name IN (
            'outbox_pending_created_idx',
            'turn_attempts_status_lease_idx',
            'deletion_requests_status_idx',
            'review_items_active_due_idx',
            'agent_inbox_claim_idx',
            'tool_executions_attempt_status_idx',
            'turn_stream_events_turn_type_seq_idx',
            'message_versions_turn_role_ver_idx'
          )
        ORDER BY name
      `);
      expect(rows.rows.map((row) => String(row.name))).toEqual([
        "agent_inbox_claim_idx",
        "deletion_requests_status_idx",
        "message_versions_turn_role_ver_idx",
        "outbox_pending_created_idx",
        "review_items_active_due_idx",
        "tool_executions_attempt_status_idx",
        "turn_attempts_status_lease_idx",
        "turn_stream_events_turn_type_seq_idx",
      ]);

      // 模拟旧库缺少新索引：重入初始化必须补回索引。
      await client.execute(`DROP INDEX agent_inbox_claim_idx`);
      await client.execute(`DROP INDEX tool_executions_attempt_status_idx`);
      await client.execute(`DROP INDEX turn_stream_events_turn_type_seq_idx`);
      await client.execute(`DROP INDEX message_versions_turn_role_ver_idx`);
      await initDatabaseSchema(client);
      const restored = await client.execute(
        `SELECT name FROM sqlite_master
         WHERE type = 'index'
           AND name IN (
             'agent_inbox_claim_idx',
             'tool_executions_attempt_status_idx',
             'turn_stream_events_turn_type_seq_idx',
             'message_versions_turn_role_ver_idx'
           )
         ORDER BY name`,
      );
      expect(restored.rows.map((row) => String(row.name))).toEqual([
        "agent_inbox_claim_idx",
        "message_versions_turn_role_ver_idx",
        "tool_executions_attempt_status_idx",
        "turn_stream_events_turn_type_seq_idx",
      ]);

      // 再次初始化必须保持幂等，不重复创建或抛错。
      await expect(initDatabaseSchema(client)).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
