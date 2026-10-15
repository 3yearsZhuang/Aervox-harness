/**
 * Aervox｜思隅 E2E — 学习规划生命周期
 *
 * 覆盖：AI 生成（template 降级）→ 列表/详情 → 任务勾选（里程碑推进）→ 归档；通过真实 API 进程验证。
 */
import { test, expect } from "@playwright/test";
import { getServerPort, getDbPath, startServer, stopServer, cleanupDb } from "./helpers.js";
import type { ChildProcess } from "child_process";

const headers = { "x-workspace-id": "ws_e2e_plan", "x-user-id": "usr_e2e_plan" };

test.describe("学习规划 E2E", () => {
  let server: ChildProcess;
  let baseURL: string;
  const dbPath = getDbPath("study-plan");

  test.beforeAll(async () => {
    cleanupDb(dbPath);
    // 非 llm 模式：规划生成走确定性模板，E2E 不依赖真实 LLM
    const started = await startServer(getServerPort(), dbPath, { AERVOX_LOOP_PROVIDER: "replay" });
    server = started.server;
    baseURL = started.url;
  });

  test.afterAll(async () => {
    stopServer(server);
    cleanupDb(dbPath);
  });

  test("生成、勾选任务推进里程碑并归档学习规划", async ({ request }) => {
    const created = await request.post(`${baseURL}/v1/learning-plans/generate`, {
      headers,
      data: { topic: "E2E 番茄钟项目", level: "beginner", dailyMinutes: 25 },
    });
    expect(created.status()).toBe(201);
    const plan = await created.json();
    expect(plan.id).toBeTruthy();
    expect(plan.generatedBy).toBe("template");
    expect(plan.milestones.length).toBeGreaterThanOrEqual(2);
    expect(plan.milestones[0].status).toBe("active");

    // 勾选首个里程碑全部任务 → completed，下一阶段解锁
    for (const task of plan.milestones[0].tasks) {
      const patched = await request.patch(`${baseURL}/v1/plan-tasks/${task.id}`, {
        headers,
        data: { status: "done" },
      });
      expect(patched.status()).toBe(200);
    }
    const progressed = await request.patch(`${baseURL}/v1/plan-tasks/${plan.milestones[1].tasks[0].id}`, {
      headers,
      data: { status: "done" },
    });
    expect(progressed.status()).toBe(200);
    const progressedBody = await progressed.json();
    expect(progressedBody.milestones[0].status).toBe("completed");
    expect(progressedBody.milestones[1].status).toBe("active");

    // 列表可见
    const listed = await request.get(`${baseURL}/v1/learning-plans`, { headers });
    expect(listed.status()).toBe(200);
    expect((await listed.json()).items.length).toBe(1);

    // 归档后列表不再显示
    const archived = await request.post(`${baseURL}/v1/learning-plans/${plan.id}/archive`, { headers });
    expect(archived.status()).toBe(200);
    expect((await archived.json()).status).toBe("archived");

    const listedAfter = await request.get(`${baseURL}/v1/learning-plans`, { headers });
    expect((await listedAfter.json()).items.length).toBe(0);
  });
});
