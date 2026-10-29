import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { createDatabase, createInMemoryDatabase, initDatabaseSchema, inspectSchemaParity } from "../src/index.js";
import { addColumnIfMissing } from "./fixtures/legacy-ddl/common.js";

describe("Schema 初始化与列迁移安全 (Issue 4 & 5)", () => {
  it("does not certify a conflicting version receipt written after its empty-file inspection", async () => {
    const database = await createInMemoryDatabase();
    const concurrent = new Proxy(database.client, {
      get(target, property) {
        if (property === "batch") return async (...args: Parameters<Client["batch"]>) => {
          const result = await target.batch(...args);
          await target.execute("INSERT INTO _aervox_schema_versions (scope, version, fingerprint, applied_at) VALUES ('main', '999', 'conflicting-release', '2026-10-29')");
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await expect(initDatabaseSchema(concurrent)).rejects.toThrow("version/fingerprint mismatch");
      const receipt = await database.client.execute("SELECT version, fingerprint FROM _aervox_schema_versions WHERE scope = 'main'");
      expect(receipt.rows[0]?.version).toBe("999");
      expect(receipt.rows[0]?.fingerprint).toBe("conflicting-release");
    } finally {
      await database.cleanup();
    }
  });

  it("API and Worker may both observe the same empty file before initializing it", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-schema-race-"));
    const url = `file:${path.join(directory, "shared.db")}`;
    const first = await createDatabase({ url });
    const second = await createDatabase({ url });
    let arrivals = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const synchronized = (client: Client): Client => {
      let initial = true;
      return new Proxy(client, {
        get(target, property) {
          if (property === "execute") return async (...args: Parameters<Client["execute"]>) => {
            const result = await target.execute(...args);
            if (initial && args[0] === "PRAGMA table_list") {
              initial = false;
              arrivals++;
              if (arrivals === 2) release();
              await ready;
            }
            return result;
          };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    };
    try {
      await expect(Promise.all([
        initDatabaseSchema(synchronized(first.client)),
        initDatabaseSchema(synchronized(second.client)),
      ])).resolves.toEqual([undefined, undefined]);
      expect(await inspectSchemaParity(first.client, "main")).toEqual([]);
      expect((await first.client.execute("SELECT * FROM _aervox_schema_versions")).rows).toHaveLength(1);
    } finally {
      first.client.close();
      second.client.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

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

      // Schema drift requires an explicit verified staging migration; bootstrap is read-only.
      await client.execute(`DROP INDEX agent_inbox_claim_idx`);
      await expect(initDatabaseSchema(client)).rejects.toThrow("explicit staging migration");
      expect((await client.execute(`SELECT name FROM sqlite_master WHERE name='agent_inbox_claim_idx'`)).rows).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});
