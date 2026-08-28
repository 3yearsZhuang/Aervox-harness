/**
 * Aervox｜思隅 @aervox/api — 思维宇宙集成测试（CAP-015）
 *
 * 覆盖：
 * - 知识关系创建（来源、关系类型、置信度）
 * - 纠正关系（corrected 停止用于讲解和推荐）
 * - 合并、拆分、删除关系
 * - 知识图谱查询（activeOnly 区分活跃 vs 历史）
 * - 租户隔离
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  SqliteLearningRepository,
  type AervoxDatabase,
} from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_tu_it",
  "x-user-id": "usr_tu_it",
} as const;

const otherHeaders = {
  "x-workspace-id": "ws_other",
  "x-user-id": "usr_other",
} as const;

const tenant = { workspaceId: "ws_tu_it", subjectUserId: "usr_tu_it" };

describe("思维宇宙集成测试（CAP-015）", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let learningRepo: SqliteLearningRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
    learningRepo = new SqliteLearningRepository(db);
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  /** 创建知识点辅助函数 */
  async function createKnowledgeItem(concept: string): Promise<string> {
    const item = await learningRepo.createKnowledgeItem(tenant, {
      id: `ki_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      concept,
    });
    return item.id;
  }

  /** 创建知识关系辅助函数 */
  async function createRelation(from: string, to: string, type = "prerequisite"): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge-relations",
      headers,
      payload: {
        fromKnowledgeId: from,
        toKnowledgeId: to,
        relationType: type,
        source: "user",
        confidence: 80,
      },
    });
    return res.json().id;
  }

  // ============ 关系创建 ============

  it("关系创建：显示来源、关系类型和置信状态", async () => {
    const from = await createKnowledgeItem("极限");
    const to = await createKnowledgeItem("连续性");

    const res = await app.inject({
      method: "POST",
      url: "/v1/knowledge-relations",
      headers,
      payload: {
        fromKnowledgeId: from,
        toKnowledgeId: to,
        relationType: "prerequisite",
        source: "user",
        confidence: 90,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.fromKnowledgeId).toBe(from);
    expect(body.toKnowledgeId).toBe(to);
    expect(body.relationType).toBe("prerequisite");
    expect(body.source).toBe("user");
    expect(body.confidence).toBe(90);
    expect(body.correctionStatus).toBe("active");
  });

  // ============ 关系查询 ============

  it("关系查询：listRelations 含历史，activeGraph 仅活跃", async () => {
    const a = await createKnowledgeItem("A");
    const b = await createKnowledgeItem("B");
    const c = await createKnowledgeItem("C");

    const rel1 = await createRelation(a, b, "prerequisite");
    const rel2 = await createRelation(a, c, "related");

    // 纠正 rel1
    await app.inject({
      method: "POST",
      url: `/v1/knowledge-relations/${rel1}/correct`,
      headers,
      payload: { reason: "关系方向错误" },
    });

    // 查询全部（含历史）
    const allRes = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations?knowledgeId=${a}`,
      headers,
    });
    expect(allRes.statusCode).toBe(200);
    expect(allRes.json().items.length).toBe(2);

    // 查询仅活跃
    const activeRes = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations?knowledgeId=${a}&activeOnly=true`,
      headers,
    });
    expect(activeRes.statusCode).toBe(200);
    const activeItems = activeRes.json().items;
    expect(activeItems.length).toBe(1);
    expect(activeItems[0].id).toBe(rel2);
  });

  // ============ 纠正关系 ============

  it("纠正关系：corrected 状态停止用于讲解和推荐", async () => {
    const a = await createKnowledgeItem("函数");
    const b = await createKnowledgeItem("导数");
    const relId = await createRelation(a, b, "causal");

    // 纠正前：在活跃图谱中
    const beforeActive = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations?knowledgeId=${a}&activeOnly=true`,
      headers,
    });
    expect(beforeActive.json().items.length).toBe(1);

    // 纠正
    const correctRes = await app.inject({
      method: "POST",
      url: `/v1/knowledge-relations/${relId}/correct`,
      headers,
      payload: { reason: "因果关系不成立" },
    });
    expect(correctRes.statusCode).toBe(200);
    expect(correctRes.json().correctionStatus).toBe("corrected");
    expect(correctRes.json().correctionReason).toBe("因果关系不成立");

    // 纠正后：不在活跃图谱中
    const afterActive = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations?knowledgeId=${a}&activeOnly=true`,
      headers,
    });
    expect(afterActive.json().items.length).toBe(0);

    // 但仍可查询历史
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations/${relId}`,
      headers,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().correctionStatus).toBe("corrected");

    // 再次纠正返回 404（已非 active）
    const reCorrect = await app.inject({
      method: "POST",
      url: `/v1/knowledge-relations/${relId}/correct`,
      headers,
      payload: { reason: "再次" },
    });
    expect(reCorrect.statusCode).toBe(404);
  });

  // ============ 合并关系 ============

  it("合并关系：源关系标记为 merged", async () => {
    const a = await createKnowledgeItem("向量");
    const b = await createKnowledgeItem("矩阵");
    const rel1 = await createRelation(a, b, "prerequisite");
    const rel2 = await createRelation(a, b, "related");

    const mergeRes = await app.inject({
      method: "POST",
      url: `/v1/knowledge-relations/${rel1}/merge`,
      headers,
      payload: { targetRelationId: rel2 },
    });
    expect(mergeRes.statusCode).toBe(200);
    expect(mergeRes.json().correctionStatus).toBe("merged");
    expect(mergeRes.json().mergedInto).toBe(rel2);

    // 合并后源关系不在活跃图谱
    const active = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations?knowledgeId=${a}&activeOnly=true`,
      headers,
    });
    expect(active.json().items.length).toBe(1);
    expect(active.json().items[0].id).toBe(rel2);
  });

  // ============ 拆分关系 ============

  it("拆分关系：标记为 split，停止用于讲解", async () => {
    const a = await createKnowledgeItem("微分");
    const b = await createKnowledgeItem("积分");
    const relId = await createRelation(a, b, "related");

    const splitRes = await app.inject({
      method: "POST",
      url: `/v1/knowledge-relations/${relId}/split`,
      headers,
      payload: { reason: "需要拆分为两个独立关系" },
    });
    expect(splitRes.statusCode).toBe(200);
    expect(splitRes.json().correctionStatus).toBe("split");
    expect(splitRes.json().correctionReason).toBe("需要拆分为两个独立关系");

    // 拆分后不在活跃图谱
    const active = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations?knowledgeId=${a}&activeOnly=true`,
      headers,
    });
    expect(active.json().items.length).toBe(0);
  });

  // ============ 删除关系 ============

  it("删除关系：软删除后不可见", async () => {
    const a = await createKnowledgeItem("数列");
    const b = await createKnowledgeItem("级数");
    const relId = await createRelation(a, b, "prerequisite");

    const delRes = await app.inject({
      method: "DELETE",
      url: `/v1/knowledge-relations/${relId}`,
      headers,
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().correctionStatus).toBe("deleted");
    expect(delRes.json().deletedAt).toBeTruthy();

    // 删除后 GET 返回 404
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations/${relId}`,
      headers,
    });
    expect(getRes.statusCode).toBe(404);
  });

  // ============ 租户隔离 ============

  it("租户隔离：不同工作区无法互相访问关系", async () => {
    const a = await createKnowledgeItem("隔离A");
    const b = await createKnowledgeItem("隔离B");
    const relId = await createRelation(a, b, "prerequisite");

    // 其他租户无法获取
    const otherGet = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations/${relId}`,
      headers: otherHeaders,
    });
    expect(otherGet.statusCode).toBe(404);

    // 其他租户无法纠正
    const otherCorrect = await app.inject({
      method: "POST",
      url: `/v1/knowledge-relations/${relId}/correct`,
      headers: otherHeaders,
      payload: { reason: "hijack" },
    });
    expect(otherCorrect.statusCode).toBe(404);

    // 其他租户无法删除
    const otherDelete = await app.inject({
      method: "DELETE",
      url: `/v1/knowledge-relations/${relId}`,
      headers: otherHeaders,
    });
    expect(otherDelete.statusCode).toBe(404);
  });

  // ============ 完整生命周期 ============

  it("完整生命周期：创建 → 纠正 → 图谱不再可见 → 历史仍可追溯", async () => {
    const a = await createKnowledgeItem("线性代数");
    const b = await createKnowledgeItem("概率论");
    const c = await createKnowledgeItem("统计学");

    // 创建3条关系
    const rel1 = await createRelation(a, b, "prerequisite");
    const rel2 = await createRelation(b, c, "prerequisite");
    const rel3 = await createRelation(a, c, "related");

    // 图谱中有3条活跃
    const active1 = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations?knowledgeId=${a}&activeOnly=true`,
      headers,
    });
    expect(active1.json().items.length).toBe(2); // a->b, a->c

    // 纠正 rel1
    await app.inject({
      method: "POST",
      url: `/v1/knowledge-relations/${rel1}/correct`,
      headers,
      payload: { reason: "不需要先修" },
    });

    // 图谱中只剩 1 条活跃（a->c）
    const active2 = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations?knowledgeId=${a}&activeOnly=true`,
      headers,
    });
    expect(active2.json().items.length).toBe(1);
    expect(active2.json().items[0].id).toBe(rel3);

    // 历史中仍有 2 条
    const history = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations?knowledgeId=${a}`,
      headers,
    });
    expect(history.json().items.length).toBe(2);

    // 删除 rel3
    await app.inject({
      method: "DELETE",
      url: `/v1/knowledge-relations/${rel3}`,
      headers,
    });

    // 图谱为空
    const active3 = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations?knowledgeId=${a}&activeOnly=true`,
      headers,
    });
    expect(active3.json().items.length).toBe(0);

    // 历史中仍有 1 条（rel1 是 corrected，仍可见；rel3 是 deleted，不可见）
    const history2 = await app.inject({
      method: "GET",
      url: `/v1/knowledge-relations?knowledgeId=${a}`,
      headers,
    });
    expect(history2.json().items.length).toBe(1);
    expect(history2.json().items[0].id).toBe(rel1);
  });
});
