import { describe, it, expect } from "vitest";
import { createInMemoryDatabase } from "../src/index.js";
import { addColumnIfMissing, initDatabaseSchema } from "../src/schema/init.js";

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
});
