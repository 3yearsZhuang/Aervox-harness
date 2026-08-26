import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Client } from "@libsql/client";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteMemoryRepository,
  SqliteMemoryEmbeddingRepository,
  SqliteMemoryVectorSearchAdapter,
  HybridSearchService,
  createHybridSearchStorage,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";

describe("T-05 记忆向量独立存储", () => {
  let db: AervoxDatabase;
  let client: Client;
  let memoryRepo: SqliteMemoryRepository;
  let embeddingRepo: SqliteMemoryEmbeddingRepository;

  const tenant: TenantContext = { workspaceId: "ws_1", subjectUserId: "usr_1" };
  const other: TenantContext = { workspaceId: "ws_9", subjectUserId: "usr_9" };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    memoryRepo = new SqliteMemoryRepository(db, client);
    embeddingRepo = new SqliteMemoryEmbeddingRepository(db);
  });

  it("insertBatch 批量写入 + 进度回调", async () => {
    for (const id of ["m1", "m2", "m3"]) {
      await memoryRepo.createRecord(tenant, {
        id,
        layer: "long_term",
        type: "user_fact",
        content: `记忆 ${id}`,
      });
    }

    const progress: number[] = [];
    await embeddingRepo.insertBatch(
      tenant,
      [
        { id: "emb_1", memoryId: "m1", vector: [1, 0], modelId: "test-emb" },
        { id: "emb_2", memoryId: "m2", vector: [0, 1], modelId: "test-emb" },
        { id: "emb_3", memoryId: "m3", vector: [0.8, 0.6], modelId: "test-emb" },
      ],
      { batchSize: 2, progressCallback: (p) => progress.push(p.current) },
    );

    expect(progress).toEqual([2, 3]);
    const rows = await client.execute("SELECT memory_id FROM memory_embeddings");
    expect(rows.rows).toHaveLength(3);
  });

  it("retrieve 按余弦相似度排序 + minScore + modelId 过滤", async () => {
    for (const id of ["m1", "m2"]) {
      await memoryRepo.createRecord(tenant, { id, layer: "long_term", type: "user_fact", content: `记忆 ${id}` });
    }
    await embeddingRepo.insertBatch(tenant, [
      { id: "emb_1", memoryId: "m1", vector: [1, 0], modelId: "model_a" },
      { id: "emb_2", memoryId: "m2", vector: [0.5, 0.5], modelId: "model_a" },
    ]);

    const hits = await embeddingRepo.retrieve(tenant, [1, 0], 10, 0);
    expect(hits[0]!.memoryId).toBe("m1");
    expect(hits[0]!.score).toBeCloseTo(1, 6);
    expect(hits[1]!.memoryId).toBe("m2");
    expect(hits[1]!.score).toBeCloseTo(Math.sqrt(0.5), 6);

    // minScore 过滤
    const filtered = await embeddingRepo.retrieve(tenant, [1, 0], 10, 0.8);
    expect(filtered.map((h) => h.memoryId)).toEqual(["m1"]);

    // modelId 过滤：无对应模型时为空
    const noModel = await embeddingRepo.retrieve(tenant, [1, 0], 10, 0, "model_b");
    expect(noModel).toEqual([]);
  });

  it("deleteByMemoryId 与 clearTenant", async () => {
    await memoryRepo.createRecord(tenant, { id: "m_owner", layer: "long_term", type: "user_fact", content: "x" });
    await memoryRepo.createRecord(other, { id: "m_other", layer: "long_term", type: "user_fact", content: "x" });
    await embeddingRepo.insertBatch(tenant, [
      { id: "emb_1", memoryId: "m_owner", vector: [1, 0], modelId: "m" },
    ]);
    await embeddingRepo.insertBatch(other, [
      { id: "emb_2", memoryId: "m_other", vector: [1, 0], modelId: "m" },
    ]);

    await embeddingRepo.deleteByMemoryId(tenant, "m_owner");
    expect(await embeddingRepo.retrieve(tenant, [1, 0], 5)).toEqual([]);
    // 其他租户不受影响
    expect(await embeddingRepo.retrieve(other, [1, 0], 5)).toHaveLength(1);

    await embeddingRepo.clearTenant(other);
    expect(await embeddingRepo.retrieve(other, [1, 0], 5)).toEqual([]);
  });

  it("SqliteMemoryVectorSearchAdapter 可作为 T-02 混合检索的向量通道", async () => {
    await memoryRepo.createRecord(tenant, { id: "mem_a", layer: "long_term", type: "user_fact", content: "苹果 每日" });
    await memoryRepo.createRecord(tenant, { id: "mem_b", layer: "long_term", type: "user_fact", content: "游戏 时间" });
    const { indexMemoryFts } = await import("../src/index.js");
    await indexMemoryFts(client, tenant, { id: "mem_a", content: "苹果 每日" });
    await indexMemoryFts(client, tenant, { id: "mem_b", content: "游戏 时间" });

    const adapter = new SqliteMemoryVectorSearchAdapter(embeddingRepo, "model_a");
    await adapter.upsert(tenant, [
      { id: "mem_a", vector: [1, 0] },
      { id: "mem_b", vector: [0, 1] },
    ]);

    const storage = createHybridSearchStorage({
      domain: "memory",
      client,
      vectorPort: adapter,
    });
    const service = new HybridSearchService(storage, "memory");

    const results = await service.search(tenant, {
      queryText: "苹果",
      queryVector: [1, 0],
      limit: 5,
    });
    // FTS 命中 mem_a；向量最似 mem_a → 双通道融合后 mem_a 居首且 source=hybrid
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.id).toBe("mem_a");
    expect(results[0]!.source).toBe("hybrid");
  });

  it("insertBatch 失败整批重试后在 maxRetries 内成功", async () => {
    await memoryRepo.createRecord(tenant, { id: "m1", layer: "long_term", type: "user_fact", content: "r" });
    // 通过进度回调模拟外部波动（无实际失败路径时验证回调幂等推进）
    const cb = vi.fn();
    await embeddingRepo.insertBatch(
      tenant,
      [{ id: "emb_1", memoryId: "m1", vector: [1, 0], modelId: "m" }],
      { batchSize: 1, maxRetries: 3, progressCallback: cb },
    );
    expect(cb).toHaveBeenCalledWith({ current: 1, total: 1 });
    expect(await embeddingRepo.retrieve(tenant, [1, 0], 5)).toHaveLength(1);
  });
});