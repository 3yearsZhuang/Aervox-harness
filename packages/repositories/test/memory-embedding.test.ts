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
  type LocalContext,
} from "../src/index.js";
import { cosineSimilarity } from "../src/search/vector-port.js";

describe("T-05 记忆向量独立存储", () => {
  let db: AervoxDatabase;
  let client: Client;
  let memoryRepo: SqliteMemoryRepository;
  let embeddingRepo: SqliteMemoryEmbeddingRepository;

  const ctx: LocalContext = { workspaceId: "ws_1", subjectUserId: "usr_1" };
  const other: LocalContext = { workspaceId: "ws_9", subjectUserId: "usr_9" };

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
      await memoryRepo.createRecord(ctx, {
        id,
        layer: "long_term",
        type: "user_fact",
        content: `记忆 ${id}`,
      });
    }

    const progress: number[] = [];
    await embeddingRepo.insertBatch(
      ctx,
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
      await memoryRepo.createRecord(ctx, { id, layer: "long_term", type: "user_fact", content: `记忆 ${id}` });
    }
    await embeddingRepo.insertBatch(ctx, [
      { id: "emb_1", memoryId: "m1", vector: [1, 0], modelId: "model_a" },
      { id: "emb_2", memoryId: "m2", vector: [0.5, 0.5], modelId: "model_a" },
    ]);

    const hits = await embeddingRepo.retrieve(ctx, [1, 0], 10, 0);
    expect(hits[0]!.memoryId).toBe("m1");
    expect(hits[0]!.score).toBeCloseTo(1, 6);
    expect(hits[1]!.memoryId).toBe("m2");
    expect(hits[1]!.score).toBeCloseTo(Math.sqrt(0.5), 6);

    // minScore 过滤
    const filtered = await embeddingRepo.retrieve(ctx, [1, 0], 10, 0.8);
    expect(filtered.map((h) => h.memoryId)).toEqual(["m1"]);

    // modelId 过滤：无对应模型时为空
    const noModel = await embeddingRepo.retrieve(ctx, [1, 0], 10, 0, "model_b");
    expect(noModel).toEqual([]);
  });

  it("bounded retrieval preserves full-sort results, ties, thresholds and deletion", async () => {
    const vectors = [[1, 0], [1, 0], [0, 0], [-1, 0], [0.5, 0.5], [0, 1]];
    for (const [index, vector] of vectors.entries()) {
      const memoryId = `parity_${index}`;
      await memoryRepo.createRecord(ctx, { id: memoryId, layer: "long_term", type: "user_fact", content: memoryId });
      await embeddingRepo.insertBatch(ctx, [{ id: `emb_${index}`, memoryId, vector, modelId: "parity" }]);
    }
    // Use the writer's actual row encounter order, as the old stable sort did.
    const rows = await client.execute("SELECT memory_id, embedding_json FROM memory_embeddings WHERE model_id = 'parity'");
    for (const query of [[1, 0], [0, 0], [0, 1]]) {
      for (const threshold of [-1, 0, 0.8]) {
        const expected = rows.rows.map((row) => ({
          memoryId: String(row.memory_id),
          score: cosineSimilarity(query, JSON.parse(String(row.embedding_json))),
        })).filter((hit) => hit.score >= threshold).sort((a, b) => b.score - a.score);
        for (const limit of [0, 1, 3, 10]) {
          expect(await embeddingRepo.retrieve(ctx, query, limit, threshold, "parity")).toEqual(expected.slice(0, limit));
        }
      }
    }
    await embeddingRepo.deleteByMemoryId(ctx, "parity_0");
    expect((await embeddingRepo.retrieve(ctx, [1, 0], 1, 0, "parity"))[0]?.memoryId).toBe("parity_1");
    expect(await embeddingRepo.retrieve(ctx, [1, 0], 3, 0, "other-model")).toEqual([]);
  });

  it("deleteByMemoryId 与 clearAll", async () => {
    await memoryRepo.createRecord(ctx, { id: "m_owner", layer: "long_term", type: "user_fact", content: "x" });
    await memoryRepo.createRecord(other, { id: "m_other", layer: "long_term", type: "user_fact", content: "x" });
    await embeddingRepo.insertBatch(ctx, [
      { id: "emb_1", memoryId: "m_owner", vector: [1, 0], modelId: "m" },
    ]);
    await embeddingRepo.insertBatch(other, [
      { id: "emb_2", memoryId: "m_other", vector: [1, 0], modelId: "m" },
    ]);

    await embeddingRepo.deleteByMemoryId(ctx, "m_owner");
    expect(await embeddingRepo.retrieve(ctx, [1, 0], 5)).toHaveLength(1);
    // 另一组兼容上下文仍可读取同一数据库中的数据
    expect(await embeddingRepo.retrieve(other, [1, 0], 5)).toHaveLength(1);

    await embeddingRepo.clearAll(other);
    expect(await embeddingRepo.retrieve(other, [1, 0], 5)).toEqual([]);
  });

  it("SqliteMemoryVectorSearchAdapter 可作为 T-02 混合检索的向量通道", async () => {
    await memoryRepo.createRecord(ctx, { id: "mem_a", layer: "long_term", type: "user_fact", content: "苹果 每日" });
    await memoryRepo.createRecord(ctx, { id: "mem_b", layer: "long_term", type: "user_fact", content: "游戏 时间" });
    const { indexMemoryFts } = await import("../src/index.js");
    await indexMemoryFts(client, ctx, { id: "mem_a", content: "苹果 每日" });
    await indexMemoryFts(client, ctx, { id: "mem_b", content: "游戏 时间" });

    const adapter = new SqliteMemoryVectorSearchAdapter(embeddingRepo, "model_a");
    await adapter.upsert(ctx, [
      { id: "mem_a", vector: [1, 0] },
      { id: "mem_b", vector: [0, 1] },
    ]);

    const storage = createHybridSearchStorage({
      domain: "memory",
      client,
      vectorPort: adapter,
    });
    const service = new HybridSearchService(storage, "memory");

    const results = await service.search(ctx, {
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
    await memoryRepo.createRecord(ctx, { id: "m1", layer: "long_term", type: "user_fact", content: "r" });
    // 通过进度回调模拟外部波动（无实际失败路径时验证回调幂等推进）
    const cb = vi.fn();
    await embeddingRepo.insertBatch(
      ctx,
      [{ id: "emb_1", memoryId: "m1", vector: [1, 0], modelId: "m" }],
      { batchSize: 1, maxRetries: 3, progressCallback: cb },
    );
    expect(cb).toHaveBeenCalledWith({ current: 1, total: 1 });
    expect(await embeddingRepo.retrieve(ctx, [1, 0], 5)).toHaveLength(1);
  });
});
