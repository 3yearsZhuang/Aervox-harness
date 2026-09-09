import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "@libsql/client";
import {
  createInMemoryDatabase,
  initFtsTables,
  indexMessageFts,
  indexMemoryFts,
  InMemoryVectorSearchAdapter,
  HybridSearchService,
  createHybridSearchStorage,
  type AervoxDatabase,
  type TenantContext,
} from "../src/index.js";

// 轻量确定性向量：成员张量维度 2，便于手工验证相似度排序
const V = {
  apple: [1, 0],
  banana: [0.9, 0.1],
  game: [0, 1],
};

describe("T-02 混合检索（FTS + 向量 RRF 融合）", () => {
  let db: AervoxDatabase;
  let client: Client;
  let vectorPort: InMemoryVectorSearchAdapter;

  const tenant: TenantContext = { workspaceId: "ws_1", subjectUserId: "usr_1" };
  const other: TenantContext = { workspaceId: "ws_9", subjectUserId: "usr_9" };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initFtsTables(client);
    vectorPort = new InMemoryVectorSearchAdapter();
  });

  it("双通道命中：RRF 融合排序并标记 hybrid / 单通道来源", async () => {
    // FTS5 unicode61 以空格为分词单元，中文内容需空格分隔；仅 mango 命中"苹果"
    await indexMessageFts(client, tenant, { id: "mango", content: "苹果 很好吃" });
    await indexMessageFts(client, tenant, { id: "banana", content: "香蕉 也不错" });
    await indexMessageFts(client, tenant, { id: "game", content: "游戏 时间到" });

    // 向量：apple 语义最近的是 apple 条目；id 与 FTS 可重叠或不同
    await vectorPort.upsert(tenant, [
      { id: "mango", vector: V.apple },
      { id: "apple", vector: V.apple },
      { id: "banana", vector: V.banana },
    ]);

    const hybrid = createHybridSearchStorage({ domain: "message", client, vectorPort });
    const service = new HybridSearchService(hybrid, "message");

    const results = await service.search(tenant, {
      queryText: "苹果",
      queryVector: V.apple,
      topK: 10,
      limit: 10,
    });

    // FTS 只有 mango；向量最似 apple/mango —— 融合后两通道都命中的 mango 应居前（hybrid）
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.source).toBe("hybrid");
    expect(results[0]!.id).toBe("mango");
    // 双通道分数等于两侧 RRF 之和 → 明显高于单通道（apple 仅向量）
    const mango = results.find((r) => r.id === "mango")!;
    const apple = results.find((r) => r.id === "apple")!;
    expect(mango.score).toBeGreaterThan(apple.score);
    expect(apple.source).toBe("vector");
    // 排序位置连续
    results.forEach((r, i) => expect(r.rank).toBe(i));
    expect(results.every((r) => r.domain === "message")).toBe(true);
  });

  it("FTS 通道为空时降级为纯向量结果", async () => {
    await vectorPort.upsert(tenant, [
      { id: "apple", vector: V.apple },
      { id: "game", vector: V.game },
    ]);
    const hybrid = createHybridSearchStorage({ domain: "message", client, vectorPort });
    const service = new HybridSearchService(hybrid, "message");

    const results = await service.search(tenant, {
      queryText: "   ", // 空/纯空白 → FTS 空
      queryVector: V.apple,
      limit: 5,
    });

    expect(results.length).toBe(2);
    expect(results[0]!.id).toBe("apple");
    expect(results.every((r) => r.source === "vector")).toBe(true);
  });

  it("向量通道为空时降级为纯 FTS 结果", async () => {
    await indexMessageFts(client, tenant, { id: "mango", content: "苹果 派" });
    const hybrid = createHybridSearchStorage({ domain: "message", client, vectorPort });
    const service = new HybridSearchService(hybrid, "message");

    const results = await service.search(tenant, {
      queryText: "苹果",
      queryVector: V.game, // 向量通道无数据 → 空
      limit: 5,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.id).toBe("mango");
    expect(results[0]!.source).toBe("fts");
  });

  it("memory 域：memories_fts 与向量融合", async () => {
    await indexMemoryFts(client, tenant, { id: "mem_a", content: "用户喜欢学习 TypeScript" });
    await indexMemoryFts(client, tenant, { id: "mem_b", content: "用户偏好深色主题" });
    await vectorPort.upsert(tenant, [
      { id: "mem_a", vector: V.apple },
      { id: "mem_b", vector: V.banana },
    ]);

    const hybrid = createHybridSearchStorage({ domain: "memory", client, vectorPort });
    const service = new HybridSearchService(hybrid, "memory");

    const results = await service.search(tenant, {
      queryText: "TypeScript",
      queryVector: V.apple,
      limit: 5,
    });

    expect(results.length).toBe(2);
    expect(results[0]!.id).toBe("mem_a");
    expect(results[0]!.source).toBe("hybrid");
  });

  it("租户隔离：其他租户无召回", async () => {
    await indexMessageFts(client, tenant, { id: "mango", content: "苹果 派" });
    const hybrid = createHybridSearchStorage({ domain: "message", client, vectorPort });
    const service = new HybridSearchService(hybrid, "message");

    const results = await service.search(other, {
      queryText: "苹果",
      queryVector: V.apple,
      limit: 5,
    });
    expect(results).toEqual([]);
  });

  it("limit 生效：只返回 topK 上限的条数", async () => {
    for (let i = 0; i < 6; i += 1) {
      await indexMessageFts(client, tenant, { id: `m${i}`, content: "苹果 每日一学" });
    }
    const hybrid = createHybridSearchStorage({ domain: "message", client, vectorPort });
    const service = new HybridSearchService(hybrid, "message");

    const results = await service.search(tenant, { queryText: "苹果", queryVector: V.apple, limit: 3 });
    expect(results.length).toBe(3);
  });
});