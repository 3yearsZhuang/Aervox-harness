import { describe, it, expect, beforeEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteProjectRepository,
  SqliteConversationRepository,
  type AervoxDatabase,
  type LocalContext,
} from "../src/index.js";
import type { Client } from "@libsql/client";

describe("CR-048 W3: SqliteProjectRepository CRUD and session association", () => {
  let db: AervoxDatabase;
  let client: Client;
  let projectRepo: SqliteProjectRepository;
  let conversationRepo: SqliteConversationRepository;

  const tenant: LocalContext = { workspaceId: "local", subjectUserId: "local" };

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    await initDatabaseSchema(client);
    projectRepo = new SqliteProjectRepository(db);
    conversationRepo = new SqliteConversationRepository(db);
  });

  it("创建、读取与列表项目", async () => {
    const p1 = await projectRepo.createProject({
      name: "考研数学一轮",
      description: "线性代数与微积分",
      color: "#4f46e5",
    });
    expect(p1.id).toBeDefined();
    expect(p1.name).toBe("考研数学一轮");

    const fetched = await projectRepo.getProjectById(p1.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.name).toBe("考研数学一轮");

    const list = await projectRepo.listProjects();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(p1.id);
  });

  it("更新与归档项目", async () => {
    const p = await projectRepo.createProject({ name: "原项目名" });
    const updated = await projectRepo.updateProject(p.id, {
      name: "新项目名",
      archived: true,
    });
    expect(updated?.name).toBe("新项目名");
    expect(updated?.archivedAt).not.toBeNull();

    // 默认列表不包含归档
    const activeList = await projectRepo.listProjects({ includeArchived: false });
    expect(activeList).toHaveLength(0);

    // 显式包含归档
    const allList = await projectRepo.listProjects({ includeArchived: true });
    expect(allList).toHaveLength(1);
  });

  it("会话归属项目与按项目过滤会话", async () => {
    const p = await projectRepo.createProject({ name: "物理竞赛" });
    const s1 = await conversationRepo.createSession(tenant, "力学第一讲", { projectId: p.id });
    const s2 = await conversationRepo.createSession(tenant, "无关日常闲聊");

    expect(s1.projectId).toBe(p.id);
    expect(s2.projectId).toBeNull();

    // 过滤属于该项目的会话
    const projectSessions = await conversationRepo.listSessions(tenant, { projectId: p.id });
    expect(projectSessions).toHaveLength(1);
    expect(projectSessions[0].id).toBe(s1.id);

    // 会话改绑项目
    const rebound = await conversationRepo.renameSession(tenant, s2.id, { projectId: p.id });
    expect(rebound?.projectId).toBe(p.id);

    const updatedProjectSessions = await conversationRepo.listSessions(tenant, { projectId: p.id });
    expect(updatedProjectSessions).toHaveLength(2);
  });

  it("删除项目自动解绑关联会话（不级联删除会话实体）", async () => {
    const p = await projectRepo.createProject({ name: "待删除项目" });
    const s = await conversationRepo.createSession(tenant, "会话 A", { projectId: p.id });

    const deleted = await projectRepo.deleteProject(p.id);
    expect(deleted).toBe(true);

    const fetchedSession = await conversationRepo.getSession(tenant, s.id);
    expect(fetchedSession).not.toBeNull();
    expect(fetchedSession?.projectId).toBeNull();

    const notFound = await projectRepo.getProjectById(p.id);
    expect(notFound).toBeNull();
  });
});
