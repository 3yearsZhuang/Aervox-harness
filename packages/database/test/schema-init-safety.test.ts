import { describe, it, expect } from "vitest";
import { createInMemoryDatabase } from "../src/index.js";
import { addColumnIfMissing, initDatabaseSchema } from "../src/schema/init.js";
import { SqliteLLMConfigRepository } from "../src/repositories/sqlite/llm-config-repository.js";
import { personaPreferences } from "../src/schema/preferences.js";

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

  it("initDatabaseSchema: 将旧租户列和索引迁移为本地单用户结构后仍可写入", async () => {
    const { db, client, cleanup } = await createInMemoryDatabase();
    try {
      await client.executeMultiple(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          subject_user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE turns (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          workspace_id TEXT NOT NULL,
          subject_user_id TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'Created',
          last_sequence INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX turns_tenant_idempotency_idx
          ON turns(workspace_id, subject_user_id, idempotency_key);
        CREATE TABLE llm_configs (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          subject_user_id TEXT NOT NULL,
          name TEXT NOT NULL DEFAULT '默认配置',
          is_active INTEGER NOT NULL DEFAULT 1,
          enabled INTEGER NOT NULL DEFAULT 1,
          provider_type TEXT NOT NULL DEFAULT 'ollama',
          base_url TEXT NOT NULL,
          api_key TEXT,
          model_id TEXT NOT NULL,
          temperature REAL NOT NULL DEFAULT 0.7,
          max_tokens INTEGER DEFAULT 4096,
          settings_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE persona_preferences (
          workspace_id TEXT NOT NULL,
          subject_user_id TEXT NOT NULL,
          id TEXT PRIMARY KEY,
          tone TEXT NOT NULL DEFAULT 'neutral',
          proactiveness TEXT NOT NULL DEFAULT 'medium',
          address_form TEXT NOT NULL DEFAULT 'none',
          reminder_cadence TEXT NOT NULL DEFAULT 'moderate',
          version INTEGER NOT NULL DEFAULT 1,
          skipped INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(workspace_id, subject_user_id)
        );
        INSERT INTO persona_preferences (workspace_id, subject_user_id, id, created_at, updated_at)
        VALUES ('legacy', 'legacy-user', 'pref_legacy', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
        INSERT INTO sessions (id, workspace_id, subject_user_id, title, created_at, updated_at)
        VALUES ('s1', 'ws1', 'u1', 'session 1', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
        INSERT INTO turns (id, session_id, workspace_id, subject_user_id, idempotency_key, created_at, updated_at)
        VALUES ('t1', 's1', 'ws1', 'u1', 'dup_key', '2026-09-09T00:00:00.000Z', '2026-09-09T00:00:00.000Z');
        INSERT INTO turns (id, session_id, workspace_id, subject_user_id, idempotency_key, created_at, updated_at)
        VALUES ('t2', 's1', 'ws2', 'u2', 'dup_key', '2026-09-09T00:00:01.000Z', '2026-09-09T00:00:01.000Z');
      `);

      await initDatabaseSchema(client);

      const llmColumns = await client.execute(`PRAGMA table_info(llm_configs)`);
      expect(llmColumns.rows.map((row) => String(row.name))).not.toContain("workspace_id");
      expect(llmColumns.rows.map((row) => String(row.name))).not.toContain("subject_user_id");

      // 旧复合索引已被清理
      const legacyTurnIndex = await client.execute(`PRAGMA index_info("turns_tenant_idempotency_idx")`);
      expect(legacyTurnIndex.rows).toHaveLength(0);

      // 新全局唯一业务索引生效
      const turnIndex = await client.execute(`PRAGMA index_info("turns_idempotency_idx")`);
      expect(turnIndex.rows.map((row) => String(row.name))).toEqual(["idempotency_key"]);

      // 存量重复的 idempotency_key 被平滑重命名去重，保证唯一索引不破坏数据
      const turnRows = await client.execute(`SELECT id, idempotency_key FROM turns ORDER BY id ASC`);
      expect(turnRows.rows).toHaveLength(2);
      const keys = turnRows.rows.map((r) => String(r.idempotency_key));
      expect(keys).toContain("dup_key");
      expect(keys.some((k) => k.startsWith("dup_key__dup_"))).toBe(true);

      const saved = await new SqliteLLMConfigRepository(db).saveConfig(
        { workspaceId: "legacy", subjectUserId: "legacy-user" },
        {
          providerType: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          modelId: "test-model",
          apiKey: null,
          temperature: 0.7,
          maxTokens: 128,
          settings: {},
        },
      );
      expect(saved.modelId).toBe("test-model");

      const preferenceColumns = await client.execute(`PRAGMA table_info(persona_preferences)`);
      expect(preferenceColumns.rows.map((row) => String(row.name))).not.toContain("workspace_id");
      const preferences = await db.select().from(personaPreferences);
      expect(preferences).toHaveLength(1);
      expect(preferences[0]?.id).toBe("pref_legacy");

      const migrations = await client.execute(
        `SELECT name FROM _migration_journal WHERE name IN ('cr-030.remove-legacy-tenant-columns', 'cr-030.migrate-tenant-unique-indexes')`,
      );
      expect(migrations.rows).toHaveLength(2);
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
