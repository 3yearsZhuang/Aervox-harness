/**
 * Aervox｜思隅 @aervox/api — 项目管理与外部会话导入测试（CR-048 / W3）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  SqliteProjectRepository,
  SqliteConversationRepository,
  type AervoxDatabase,
} from "@aervox/repositories";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

describe("项目管理与会话导入路由测试（CR-048 / W3）", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;
  let convRepo: SqliteConversationRepository;
  let projRepo: SqliteProjectRepository;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
    convRepo = new SqliteConversationRepository(db);
    projRepo = new SqliteProjectRepository(db);
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("支持创建项目并查询列表", async () => {
    const resCreate = await app.inject({
      method: "POST",
      url: "/v1/projects",
      payload: {
        name: "量子力学入门",
        description: "从薛定谔方程到量子隐形传态",
        color: "#6366f1",
        icon: "atom",
      },
    });
    expect(resCreate.statusCode).toBe(201);
    const created = resCreate.json();
    expect(created.id).toBeDefined();
    expect(created.name).toBe("量子力学入门");
    expect(created.color).toBe("#6366f1");

    const resList = await app.inject({
      method: "GET",
      url: "/v1/projects",
    });
    expect(resList.statusCode).toBe(200);
    const list = resList.json();
    expect(list.items).toHaveLength(1);
    expect(list.items[0].id).toBe(created.id);
  });

  it("支持更新项目与归档过滤", async () => {
    const created = await projRepo.createProject({ workspaceId: "local", subjectUserId: "local" }, {
      name: "待归档项目",
    });

    const resPatch = await app.inject({
      method: "PATCH",
      url: `/v1/projects/${created.id}`,
      payload: {
        name: "已更新名称",
        archived: true,
      },
    });
    expect(resPatch.statusCode).toBe(200);
    const patched = resPatch.json();
    expect(patched.name).toBe("已更新名称");
    expect(patched.archivedAt).not.toBeNull();

    // 默认列表不含已归档项目
    const resListActive = await app.inject({
      method: "GET",
      url: "/v1/projects",
    });
    expect(resListActive.json().items).toHaveLength(0);

    // includeArchived=true 包含归档项目
    const resListAll = await app.inject({
      method: "GET",
      url: "/v1/projects?includeArchived=true",
    });
    expect(resListAll.json().items).toHaveLength(1);
  });

  it("删除项目时解绑关联会话而不级联销毁会话", async () => {
    const project = await projRepo.createProject({ workspaceId: "local", subjectUserId: "local" }, {
      name: "即将删除的项目",
    });

    // 创建关联会话
    const resSession = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      payload: {
        title: "项目下属会话",
        projectId: project.id,
      },
    });
    expect(resSession.statusCode).toBe(201);
    const session = resSession.json();
    expect(session.projectId).toBe(project.id);

    // 删除项目
    const resDelete = await app.inject({
      method: "DELETE",
      url: `/v1/projects/${project.id}`,
    });
    expect(resDelete.statusCode).toBe(204);

    // 会话依然存在，但 projectId 变为 null
    const resGetSessions = await app.inject({
      method: "GET",
      url: "/v1/sessions",
    });
    const found = resGetSessions.json().items.find((s: any) => s.id === session.id);
    expect(found).toBeDefined();
    expect(found.projectId).toBeNull();
  });

  it("支持按 projectId 过滤会话列表", async () => {
    const p1 = await projRepo.createProject({ workspaceId: "local", subjectUserId: "local" }, { name: "P1" });
    const p2 = await projRepo.createProject({ workspaceId: "local", subjectUserId: "local" }, { name: "P2" });

    await convRepo.createSession({ workspaceId: "local", subjectUserId: "local" }, "S1", { projectId: p1.id });
    await convRepo.createSession({ workspaceId: "local", subjectUserId: "local" }, "S2", { projectId: p2.id });

    const resP1 = await app.inject({
      method: "GET",
      url: `/v1/sessions?projectId=${p1.id}`,
    });
    expect(resP1.statusCode).toBe(200);
    const p1Sessions = resP1.json().items;
    expect(p1Sessions).toHaveLength(1);
    expect(p1Sessions[0].title).toBe("S1");
  });

  it("POST /v1/sessions/import 成功导入外部会话", async () => {
    const project = await projRepo.createProject({ workspaceId: "local", subjectUserId: "local" }, { name: "导入归宿" });

    const resImport = await app.inject({
      method: "POST",
      url: "/v1/sessions/import",
      payload: {
        title: "外部ChatGPT导出会话",
        projectId: project.id,
        messages: [
          { role: "user", content: "请解释快速傅里叶变换 FFT" },
          { role: "assistant", content: "FFT 是离散傅里叶变换的快速算法，复杂度为 O(N log N)。" },
          { role: "user", content: "Cooley-Tukey 算法的核心是什么？" },
          { role: "assistant", content: "核心是分治策略（Divide and Conquer），将奇数点和偶数点递归分解。" },
        ],
      },
    });

    expect(resImport.statusCode).toBe(201);
    const data = resImport.json();
    expect(data.session).toBeDefined();
    expect(data.session.title).toBe("外部ChatGPT导出会话");
    expect(data.session.projectId).toBe(project.id);
    expect(data.turnsCount).toBe(2);
    expect(data.messagesCount).toBe(4);

    // 查询该会话可以在 sessions 列表中读出
    const resSessions = await app.inject({
      method: "GET",
      url: `/v1/sessions?projectId=${project.id}`,
    });
    expect(resSessions.statusCode).toBe(200);
    expect(resSessions.json().items.some((s: any) => s.id === data.session.id)).toBe(true);
  });
});
