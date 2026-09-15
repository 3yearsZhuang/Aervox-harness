/**
 * Aervox｜思隅 @aervox/contracts — CR-048 项目与外部会话导入契约测试
 */
import { describe, expect, it } from "vitest";
import {
  projectItemSchema,
  listProjectsResponseSchema,
  createProjectRequestSchema,
  updateProjectRequestSchema,
  importSessionRequestSchema,
  importSessionResponseSchema,
  sessionItemSchema,
} from "../src/index.js";

describe("CR-048 项目与导入契约模式测试", () => {
  it("sessionItemSchema 支持可选可空 projectId", () => {
    const valid = sessionItemSchema.parse({
      id: "ses_001",
      title: "关于线性代数的讨论",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projectId: "proj_001",
    });
    expect(valid.projectId).toBe("proj_001");

    const nullProject = sessionItemSchema.parse({
      id: "ses_002",
      title: "默认会话",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      projectId: null,
    });
    expect(nullProject.projectId).toBeNull();
  });

  it("projectItemSchema 校验项目数据模型", () => {
    const project = projectItemSchema.parse({
      id: "proj_001",
      name: "考研数学一轮复习",
      description: "包含高数、线代、概统",
      color: "#4f46e5",
      icon: "calculator",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
    });
    expect(project.id).toBe("proj_001");
    expect(project.name).toBe("考研数学一轮复习");
  });

  it("listProjectsResponseSchema 正确解析多项", () => {
    const list = listProjectsResponseSchema.parse({
      items: [
        {
          id: "proj_1",
          name: "项目 1",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    expect(list.items).toHaveLength(1);
  });

  it("createProjectRequestSchema 与 updateProjectRequestSchema 约束正确", () => {
    const createReq = createProjectRequestSchema.parse({
      name: "新项目",
      color: "#ff0000",
    });
    expect(createReq.name).toBe("新项目");

    const updateReq = updateProjectRequestSchema.parse({
      name: "更名项目",
      archived: true,
    });
    expect(updateReq.archived).toBe(true);

    expect(() => createProjectRequestSchema.parse({ name: "" })).toThrow();
  });

  it("importSessionRequestSchema 校验消息序列与上限", () => {
    const importReq = importSessionRequestSchema.parse({
      title: "历史对话导入",
      projectId: "proj_001",
      messages: [
        { role: "user", content: "什么是拉格朗日乘子法？" },
        { role: "assistant", content: "拉格朗日乘子法是一种寻找多元函数条件极值的方法..." },
      ],
    });
    expect(importReq.messages).toHaveLength(2);
    expect(importReq.projectId).toBe("proj_001");

    // 空消息列表拒绝
    expect(() => importSessionRequestSchema.parse({ messages: [] })).toThrow();
  });

  it("importSessionResponseSchema 校验导入结果", () => {
    const res = importSessionResponseSchema.parse({
      session: {
        id: "ses_imported_1",
        title: "导入会话",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        projectId: "proj_001",
      },
      turnsCount: 2,
      messagesCount: 4,
    });
    expect(res.turnsCount).toBe(2);
    expect(res.messagesCount).toBe(4);
  });
});
