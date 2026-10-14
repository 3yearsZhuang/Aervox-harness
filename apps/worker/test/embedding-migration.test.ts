import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteMemoryEmbeddingRepository,
  SqliteMemoryRepository,
  type AervoxDatabase,
  type LocalContext,
} from "@aervox/repositories";
import type { Client } from "@libsql/client";
import { runEmbeddingMigrationCycle } from "../src/embedding-migration.js";
import { LocalFeatureHashEmbeddingProvider } from "@aervox/host-agent";

describe("Worker 记忆向量平滑迁移 (Embedding Migration)", () => {
  let db: AervoxDatabase;
  let client: Client;
  let embeddingRepo: SqliteMemoryEmbeddingRepository;
  let memoryRepo: SqliteMemoryRepository;

  const localCtx: LocalContext = {
    workspaceId: "ws_migration",
    subjectUserId: "usr_migration",
  };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    embeddingRepo = new SqliteMemoryEmbeddingRepository(db);
    memoryRepo = new SqliteMemoryRepository(db, client);
  });

  it("当未注入 provider 时诚实返回 0，不执行迁移", async () => {
    const migrated = await runEmbeddingMigrationCycle({
      db,
      client,
      embeddingRepo,
      provider: null,
      workerId: "worker-test",
    });
    expect(migrated).toBe(0);
  });

  it("当注入真实 provider 时，自动扫描未向量化记忆并批量生成与写入向量", async () => {
    // 1. 创建两条记忆记录（尚未生成向量）
    const mem1 = await memoryRepo.createRecord(localCtx, {
      id: "mem_1",
      layer: "short_term",
      type: "fact",
      content: "用户喜欢喝乌龙茶",
    });
    const mem2 = await memoryRepo.createRecord(localCtx, {
      id: "mem_2",
      layer: "long_term",
      type: "preference",
      content: "用户的猫咪叫团团",
    });

    const provider = new LocalFeatureHashEmbeddingProvider(256);

    // 2. 执行第一轮向量迁移
    const migrated = await runEmbeddingMigrationCycle({
      db,
      client,
      embeddingRepo,
      provider,
      workerId: "worker-test",
    });

    expect(migrated).toBe(2);

    // 3. 验证 memory_embeddings 表中已写入两条向量记录，且 modelId 一致
    const rows = await client.execute({
      sql: "SELECT memory_id, model_id FROM memory_embeddings",
    });
    expect(rows.rows).toHaveLength(2);
    const memoryIds = rows.rows.map((r) => String(r.memory_id));
    expect(memoryIds).toContain(mem1.id);
    expect(memoryIds).toContain(mem2.id);
    expect(String(rows.rows[0]?.model_id)).toBe(provider.modelId);

    // 4. 第二轮执行应返回 0（幂等无新增）
    const secondCycle = await runEmbeddingMigrationCycle({
      db,
      client,
      embeddingRepo,
      provider,
      workerId: "worker-test",
    });
    expect(secondCycle).toBe(0);
  });
});
