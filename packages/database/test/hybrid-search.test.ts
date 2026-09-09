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
    await indexMessageFts(client, { id: "mango", content: "苹果 很好吃" });
    await indexMessageFts(client, { id: "banana", content: "香蕉 也不错" });
    await indexMessageFts(client, { id: "game", content: "游戏 时间到" });

    // 向量：apple 语义最近的是 apple 条目；id 与 FTS 可重叠或不同
    await vectorPort.upsert([
      { id: "mango", vector: V.apple },
      { id: "apple", vector: V.apple },
      { id: "banana", vector: V.banana },
    ]);

    const hybrid = createHybridSearchStorage({ domain: "message", client, vectorPort });
    const service = new HybridSearchService(hybrid, "message");

    const results = await service.search({
      queryText: "苹果",
      queryVector: V.apple,
      topK: 10,
      limit: 10,
    });

    expect(results.length).toBeGreaterThan(0);
    // mango 同时命中两路，应为 hybrid 且排名第一
    expect(results[0]!.id).toBe("mango");
    expect(results[0]!.source).toBe("hybrid");

    // 来源标签互斥验证
    for (const hit of results) {
      expect(["hybrid", "fts", "vector"]).toContain(hit.source);
    }
  });

  it("FTS 通道为空时降级为纯向量结果", async () => {
    await vectorPort.upsert([
      { id: "v1", vector: V.apple },
      { id: "v2", vector: V.banana },
    ]);

    const hybrid = createHybridSearchStorage({ domain: "message", client, vectorPort });
    const service = new HybridSearchService(hybrid, "message");

    // queryText 为空文本，FTS 不产出结果
    const results = await service.search({
      queryText: "   ",
      queryVector: V.apple,
      limit: 10,
    });

    expect(results.length).toBe(2);
    expect(results.every((r) => r.source === "vector")).toBe(true);
    expect(results[0]!.id).toBe("v1");
  });

  it("向量通道为空时降级为纯 FTS 结果", async () => {
    await indexMessageFts(client, { id: "m1", content: "测试 纯 文本 检索" });

    // 故意设极高相似度阈值让向量通道空返回
    const hybrid = createHybridSearchStorage({ domain: "message", client, vectorPort });
    const service = new HybridSearchService(hybrid, "message");

    const results = await service.search({
      queryText: "文本",
      queryVector: V.game,
      minVectorScore: 0.99,
      limit: 10,
    });

    expect(results.length).toBe(1);
    expect(results[0]!.source).toBe("fts");
    expect(results[0]!.id).toBe("m1");
  });

  it("memory 域：memories_fts 与向量融合", async () => {
    await indexMemoryFts(client, { id: "mem_a", content: "关于 TypeScript 泛型 的 记忆" });
    await indexMemoryFts(client, { id: "mem_b", content: "今天 天气 晴朗" });

    await vectorPort.upsert([
      { id: "mem_a", vector: V.apple },
      { id: "mem_c", vector: V.banana },
    ]);

    const hybrid = createHybridSearchStorage({ domain: "memory", client, vectorPort });
    const service = new HybridSearchService(hybrid, "memory");

    const results = await service.search({
      queryText: "TypeScript",
      queryVector: V.apple,
      limit: 5,
    });

    expect(results.length).toBe(2);
    expect(results[0]!.id).toBe("mem_a");
    expect(results[0]!.source).toBe("hybrid");
  });

  it("limit 生效：只返回 topK 上限的条数", async () => {
    for (let i = 0; i < 6; i += 1) {
      await indexMessageFts(client, { id: `m${i}`, content: "苹果 每日一学" });
    }
    const hybrid = createHybridSearchStorage({ domain: "message", client, vectorPort });
    const service = new HybridSearchService(hybrid, "message");

    const results = await service.search({ queryText: "苹果", queryVector: V.apple, limit: 3 });
    expect(results.length).toBe(3);
  });
});