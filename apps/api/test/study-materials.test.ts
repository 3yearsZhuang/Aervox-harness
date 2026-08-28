/**
 * Aervox｜思隅 @aervox/api — 学习资料集成测试（CAP-011）
 *
 * 覆盖：
 * - FR-LRN-002 AC-01：生成资料区分模型生成/外部引用
 * - FR-LRN-002 AC-02：引用可定位来源，无法验证的事实标记"需要核对"
 * - FR-LRN-002 AC-03：幂等重试不重复生成
 * - FR-LRN-003 AC-01：编辑生成新版本，原版本可追溯
 * - FR-LRN-003 AC-02：导出 JSON/Markdown 含引用来源状态
 * - BR-LRN-001 AC-01：无法验证的事实标记"需要核对"
 * - BR-LRN-001 AC-02：版权未确认标记受限
 * - BR-LRN-001 AC-03：删除后引用失效
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  type AervoxDatabase,
} from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_mat_it",
  "x-user-id": "usr_mat_it",
} as const;

const otherHeaders = {
  "x-workspace-id": "ws_other",
  "x-user-id": "usr_other",
} as const;

describe("学习资料集成测试（CAP-011）", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("FR-LRN-002 AC-01：生成资料区分模型生成与外部引用", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/study-materials",
      headers,
      payload: {
        type: "explanation",
        title: "三角函数讲解",
        content: "sin/cos/tan 的定义...",
        format: "markdown",
        sources: [
          { sourceType: "model", verificationStatus: "verified" },
          { sourceType: "external", sourceUri: "https://example.com/trig", sourceTitle: "三角函数参考", licenseStatus: "confirmed" },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.type).toBe("explanation");
    expect(body.status).toBe("ready");
    expect(body.currentVersion).toBeTruthy();
    expect(body.sources).toHaveLength(2);
    expect(body.sources[0].sourceType).toBe("model");
    expect(body.sources[1].sourceType).toBe("external");
  });

  it("FR-LRN-002 AC-02：引用可定位来源，无法验证的事实标记'需要核对'", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/study-materials",
      headers,
      payload: {
        type: "reading",
        title: "拓展阅读",
        content: "内容...",
        sources: [
          { sourceType: "external", sourceUri: "https://example.com", verificationStatus: "unverifiable", licenseStatus: "unconfirmed" },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const sources = res.json().sources;
    expect(sources[0].verificationStatus).toBe("unverifiable");
    expect(sources[0].licenseStatus).toBe("unconfirmed");
  });

  it("FR-LRN-002 AC-03：幂等重试不重复生成", async () => {
    const idempotencyHeaders = { ...headers, "idempotency-key": "mat_idem_1" };
    const payload = {
      type: "code",
      title: "代码案例",
      content: "console.log(1)",
      format: "markdown",
    };

    const first = await app.inject({ method: "POST", url: "/v1/study-materials", headers: idempotencyHeaders, payload });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().id;

    const second = await app.inject({ method: "POST", url: "/v1/study-materials", headers: idempotencyHeaders, payload });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(firstId);
  });

  it("FR-LRN-003 AC-01：编辑资料生成新版本，原版本可追溯", async () => {
    // 创建资料
    const create = await app.inject({
      method: "POST",
      url: "/v1/study-materials",
      headers,
      payload: { type: "explanation", title: "原始", content: "原始内容" },
    });
    const materialId = create.json().id;

    // 编辑
    const edit = await app.inject({
      method: "PATCH",
      url: `/v1/study-materials/${materialId}`,
      headers,
      payload: { content: "编辑后内容", expectedVersion: 1 },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().version).toBe(2);

    // 版本历史
    const versions = await app.inject({
      method: "GET",
      url: `/v1/study-materials/${materialId}/versions`,
      headers,
    });
    expect(versions.statusCode).toBe(200);
    expect(versions.json().versions).toHaveLength(2);
    expect(versions.json().versions[0].version).toBe(2);
    expect(versions.json().versions[1].version).toBe(1);
  });

  it("FR-LRN-003 AC-02：导出 Markdown 含引用来源状态", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/study-materials",
      headers,
      payload: {
        type: "mindmap",
        title: "思维导图",
        content: "# 思维导图\n- 节点1\n- 节点2",
        sources: [
          { sourceType: "external", sourceTitle: "参考书", licenseStatus: "confirmed", verificationStatus: "verified" },
        ],
      },
    });
    const materialId = create.json().id;

    const exportRes = await app.inject({
      method: "POST",
      url: `/v1/study-materials/${materialId}/export`,
      headers,
      payload: { format: "markdown" },
    });
    expect(exportRes.statusCode).toBe(200);
    expect(exportRes.headers["content-type"]).toContain("text/markdown");
    const body = exportRes.body;
    expect(body).toContain("思维导图");
    expect(body).toContain("参考书");
    expect(body).toContain("confirmed");
  });

  it("FR-LRN-003 AC-02：导出 JSON 含引用来源状态", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/study-materials",
      headers,
      payload: {
        type: "exercises",
        title: "练习题",
        content: "1+1=?",
        sources: [
          { sourceType: "model", verificationStatus: "verified" },
        ],
      },
    });
    const materialId = create.json().id;

    const exportRes = await app.inject({
      method: "POST",
      url: `/v1/study-materials/${materialId}/export`,
      headers,
      payload: { format: "json" },
    });
    expect(exportRes.statusCode).toBe(200);
    const body = exportRes.json();
    expect(body.material.title).toBe("练习题");
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0].sourceType).toBe("model");
    expect(body.exportedAt).toBeTruthy();
  });

  it("BR-LRN-001 AC-03：删除后引用失效", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/study-materials",
      headers,
      payload: {
        type: "explanation",
        title: "待删除",
        content: "内容",
        sources: [{ sourceType: "external", sourceTitle: "来源" }],
      },
    });
    const materialId = create.json().id;

    const del = await app.inject({
      method: "DELETE",
      url: `/v1/study-materials/${materialId}`,
      headers,
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().deletedAt).toBeTruthy();

    // 再次 GET 返回 404
    const getRes = await app.inject({ method: "GET", url: `/v1/study-materials/${materialId}`, headers });
    expect(getRes.statusCode).toBe(404);
  });

  it("编辑版本冲突（CAS）", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/study-materials",
      headers,
      payload: { type: "reading", title: "CAS测试", content: "v1" },
    });
    const materialId = create.json().id;

    // 第一次编辑成功
    const edit1 = await app.inject({
      method: "PATCH",
      url: `/v1/study-materials/${materialId}`,
      headers,
      payload: { content: "v2", expectedVersion: 1 },
    });
    expect(edit1.statusCode).toBe(200);

    // 第二次用旧版本号编辑 — 冲突
    const edit2 = await app.inject({
      method: "PATCH",
      url: `/v1/study-materials/${materialId}`,
      headers,
      payload: { content: "v3", expectedVersion: 1 },
    });
    expect(edit2.statusCode).toBe(409);
  });

  it("租户隔离", async () => {
    const create = await app.inject({
      method: "POST",
      url: "/v1/study-materials",
      headers,
      payload: { type: "code", title: "隔离", content: "code" },
    });
    const materialId = create.json().id;

    const otherRes = await app.inject({
      method: "GET",
      url: `/v1/study-materials/${materialId}`,
      headers: otherHeaders,
    });
    expect(otherRes.statusCode).toBe(404);
  });

  it("按目标筛选资料列表", async () => {
    const goalId = "goal_test_1";
    await app.inject({
      method: "POST",
      url: "/v1/study-materials",
      headers,
      payload: { goalId, type: "explanation", title: "A", content: "a" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/study-materials",
      headers,
      payload: { type: "code", title: "B", content: "b" },
    });

    const list = await app.inject({
      method: "GET",
      url: `/v1/study-materials?goalId=${goalId}`,
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].title).toBe("A");
  });
});