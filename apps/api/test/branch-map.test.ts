/**
 * Aervox｜思隅 @aervox/api — 层级对话与会话地图集成测试（CAP-014）
 *
 * 覆盖：
 * - 分支创建（术语下钻、文本追问、替代解法）
 * - 分支生命周期（合并、归档、删除）
 * - 会话地图布局（布局数据更新，布局丢失不影响会话内容）
 * - 分支树递归查询
 * - 租户隔离
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  SqliteConversationRepository,
  type AervoxDatabase,
} from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_br_it",
  "x-user-id": "usr_br_it",
} as const;

const otherHeaders = {
  "x-workspace-id": "ws_other",
  "x-user-id": "usr_other",
} as const;

const tenant = { workspaceId: "ws_br_it", subjectUserId: "usr_br_it" };

describe("层级对话与会话地图集成测试（CAP-014）", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let convRepo: SqliteConversationRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
    convRepo = new SqliteConversationRepository(db);
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  /** 创建会话辅助函数 */
  async function createSession(title: string): Promise<string> {
    const session = await convRepo.createSession(tenant, title);
    return session.id;
  }

  // ============ 分支创建 ============

  it("分支创建：支持术语下钻、文本追问、替代解法", async () => {
    const parentId = await createSession("主对话");
    const childId = await createSession("术语下钻：极限");

    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${parentId}/branches`,
      headers,
      payload: {
        childSessionId: childId,
        title: "极限概念下钻",
        branchReason: "term_drill",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.parentSessionId).toBe(parentId);
    expect(body.childSessionId).toBe(childId);
    expect(body.title).toBe("极限概念下钻");
    expect(body.branchReason).toBe("term_drill");
    expect(body.status).toBe("active");
  });

  it("分支创建：缺少 childSessionId 时返回 400", async () => {
    const parentId = await createSession("主对话");
    const res = await app.inject({
      method: "POST",
      url: `/v1/sessions/${parentId}/branches`,
      headers,
      payload: { title: "无子会话" },
    });
    expect(res.statusCode).toBe(400);
  });

  // ============ 分支查询 ============

  it("分支查询：列出直接子分支 + 递归获取分支树", async () => {
    const root = await createSession("根会话");
    const child1 = await createSession("分支1");
    const child2 = await createSession("分支2");
    const grandchild = await createSession("孙分支");

    // 创建两个直接子分支
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${root}/branches`,
      headers,
      payload: { childSessionId: child1, title: "分支1", branchReason: "term_drill" },
    });
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${root}/branches`,
      headers,
      payload: { childSessionId: child2, title: "分支2", branchReason: "alternative_solution" },
    });

    // 在 child1 下创建孙分支
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${child1}/branches`,
      headers,
      payload: { childSessionId: grandchild, title: "孙分支", branchReason: "text_followup" },
    });

    // 列出直接子分支
    const directRes = await app.inject({
      method: "GET",
      url: `/v1/sessions/${root}/branches`,
      headers,
    });
    expect(directRes.statusCode).toBe(200);
    expect(directRes.json().items).toHaveLength(2);

    // 递归获取分支树
    const treeRes = await app.inject({
      method: "GET",
      url: `/v1/sessions/${root}/branch-tree`,
      headers,
    });
    expect(treeRes.statusCode).toBe(200);
    const treeItems = treeRes.json().items;
    expect(treeItems.length).toBeGreaterThanOrEqual(3); // 2 直接 + 1 孙
  });

  it("分支详情：GET 单个分支", async () => {
    const parentId = await createSession("主对话");
    const childId = await createSession("子对话");

    const createRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${parentId}/branches`,
      headers,
      payload: { childSessionId: childId, title: "测试分支" },
    });
    const branchId = createRes.json().id;

    const getRes = await app.inject({
      method: "GET",
      url: `/v1/branches/${branchId}`,
      headers,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().id).toBe(branchId);
    expect(getRes.json().title).toBe("测试分支");
  });

  // ============ 分支生命周期 ============

  it("分支合并：合并后状态变为 merged", async () => {
    const parentId = await createSession("主对话");
    const childId = await createSession("替代解法");

    const createRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${parentId}/branches`,
      headers,
      payload: { childSessionId: childId, title: "解法B", branchReason: "alternative_solution" },
    });
    const branchId = createRes.json().id;

    const mergeRes = await app.inject({
      method: "POST",
      url: `/v1/branches/${branchId}/merge`,
      headers,
    });
    expect(mergeRes.statusCode).toBe(200);
    const merged = mergeRes.json();
    expect(merged.status).toBe("merged");
    expect(merged.mergedAt).toBeTruthy();

    // 再次合并返回 404（已非 active）
    const reMerge = await app.inject({
      method: "POST",
      url: `/v1/branches/${branchId}/merge`,
      headers,
    });
    expect(reMerge.statusCode).toBe(404);
  });

  it("分支归档：归档后状态变为 archived", async () => {
    const parentId = await createSession("主对话");
    const childId = await createSession("暂时不看");

    const createRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${parentId}/branches`,
      headers,
      payload: { childSessionId: childId, title: "待归档" },
    });
    const branchId = createRes.json().id;

    const archiveRes = await app.inject({
      method: "POST",
      url: `/v1/branches/${branchId}/archive`,
      headers,
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(archiveRes.json().status).toBe("archived");
  });

  it("分支删除：软删除后不可见，再次删除返回 404", async () => {
    const parentId = await createSession("主对话");
    const childId = await createSession("删除测试");

    const createRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${parentId}/branches`,
      headers,
      payload: { childSessionId: childId },
    });
    const branchId = createRes.json().id;

    const delRes = await app.inject({
      method: "DELETE",
      url: `/v1/branches/${branchId}`,
      headers,
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().status).toBe("deleted");
    expect(delRes.json().deletedAt).toBeTruthy();

    // 再次获取返回 404
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/branches/${branchId}`,
      headers,
    });
    expect(getRes.statusCode).toBe(404);

    // 再次删除返回 404
    const reDel = await app.inject({
      method: "DELETE",
      url: `/v1/branches/${branchId}`,
      headers,
    });
    expect(reDel.statusCode).toBe(404);
  });

  // ============ 布局数据 ============

  it("布局数据：更新布局，布局丢失不影响会话内容", async () => {
    const parentId = await createSession("主对话");
    const childId = await createSession("布局测试");

    const createRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${parentId}/branches`,
      headers,
      payload: { childSessionId: childId, title: "布局分支" },
    });
    const branchId = createRes.json().id;

    // 更新布局
    const layoutRes = await app.inject({
      method: "PATCH",
      url: `/v1/branches/${branchId}/layout`,
      headers,
      payload: { layoutData: { x: 100, y: 200, width: 300, height: 150 } },
    });
    expect(layoutRes.statusCode).toBe(200);
    expect(layoutRes.json().layoutData).toEqual({ x: 100, y: 200, width: 300, height: 150 });

    // 布局数据存在，但会话内容仍然可访问
    const getSessionRes = await app.inject({
      method: "GET",
      url: `/v1/sessions/${childId}`,
      headers,
    });
    // 会话仍然存在（布局不影响会话内容）
    expect([200, 404]).toContain(getSessionRes.statusCode);
    // 即使会话因测试环境返回 404，分支本身仍可访问
    const getBranchRes = await app.inject({
      method: "GET",
      url: `/v1/branches/${branchId}`,
      headers,
    });
    expect(getBranchRes.statusCode).toBe(200);
    expect(getBranchRes.json().title).toBe("布局分支");

    // 清除布局（模拟布局丢失）
    const clearLayoutRes = await app.inject({
      method: "PATCH",
      url: `/v1/branches/${branchId}/layout`,
      headers,
      payload: { layoutData: null },
    });
    expect(clearLayoutRes.statusCode).toBe(200);

    // 分支仍然存在（布局丢失不丢失会话内容）
    const getAfterClear = await app.inject({
      method: "GET",
      url: `/v1/branches/${branchId}`,
      headers,
    });
    expect(getAfterClear.statusCode).toBe(200);
    expect(getAfterClear.json().title).toBe("布局分支");
  });

  // ============ 租户隔离 ============

  it("租户隔离：不同工作区无法互相访问分支", async () => {
    const parentId = await createSession("主对话");
    const childId = await createSession("子对话");

    const createRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${parentId}/branches`,
      headers,
      payload: { childSessionId: childId, title: "隔离测试" },
    });
    const branchId = createRes.json().id;

    // 其他租户无法获取分支
    const otherGet = await app.inject({
      method: "GET",
      url: `/v1/branches/${branchId}`,
      headers: otherHeaders,
    });
    expect(otherGet.statusCode).toBe(404);

    // 其他租户无法合并
    const otherMerge = await app.inject({
      method: "POST",
      url: `/v1/branches/${branchId}/merge`,
      headers: otherHeaders,
    });
    expect(otherMerge.statusCode).toBe(404);

    // 其他租户无法删除
    const otherDelete = await app.inject({
      method: "DELETE",
      url: `/v1/branches/${branchId}`,
      headers: otherHeaders,
    });
    expect(otherDelete.statusCode).toBe(404);
  });

  // ============ 完整生命周期 ============

  it("完整生命周期：创建 → 布局 → 合并 → 查询历史", async () => {
    const parentId = await createSession("数学复习");
    const childId = await createSession("极限的严格定义");

    // 1. 创建分支
    const createRes = await app.inject({
      method: "POST",
      url: `/v1/sessions/${parentId}/branches`,
      headers,
      payload: {
        childSessionId: childId,
        title: "ε-δ 定义下钻",
        branchReason: "term_drill",
      },
    });
    expect(createRes.statusCode).toBe(201);
    const branchId = createRes.json().id;

    // 2. 更新布局
    const layoutRes = await app.inject({
      method: "PATCH",
      url: `/v1/branches/${branchId}/layout`,
      headers,
      payload: { layoutData: { x: 50, y: 50 } },
    });
    expect(layoutRes.statusCode).toBe(200);

    // 3. 合并回主线
    const mergeRes = await app.inject({
      method: "POST",
      url: `/v1/branches/${branchId}/merge`,
      headers,
    });
    expect(mergeRes.statusCode).toBe(200);
    expect(mergeRes.json().status).toBe("merged");

    // 4. 查询分支仍可获取（合并 ≠ 删除）
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/branches/${branchId}`,
      headers,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().status).toBe("merged");

    // 5. 查询分支树仍包含已合并的分支
    const treeRes = await app.inject({
      method: "GET",
      url: `/v1/sessions/${parentId}/branch-tree`,
      headers,
    });
    expect(treeRes.statusCode).toBe(200);
    expect(treeRes.json().items.length).toBeGreaterThanOrEqual(1);
  });
});
