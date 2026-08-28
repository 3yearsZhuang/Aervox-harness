/**
 * Aervox｜思隅 E2E — 学习计划生命周期
 *
 * 覆盖：创建 → 滚动调整 → 风险预测 → 归档；通过真实 API 进程验证。
 */
import { test, expect } from "@playwright/test";
import { getServerPort, getDbPath, startServer, stopServer, cleanupDb } from "./helpers.js";
import type { ChildProcess } from "child_process";

const headers = { "x-workspace-id": "ws_e2e_plan", "x-user-id": "usr_e2e_plan" };

test.describe("学习计划 E2E", () => {
  let server: ChildProcess;
  let baseURL: string;
  let planId: string;
  const dbPath = getDbPath("study-plan");

  test.beforeAll(async () => {
    cleanupDb(dbPath);
    const started = await startServer(getServerPort(), dbPath);
    server = started.server;
    baseURL = started.url;
  });

  test.afterAll(async () => {
    stopServer(server);
    cleanupDb(dbPath);
  });

  test("创建、调整、标记风险并归档学习计划", async ({ request }) => {
    const created = await request.post(`${baseURL}/v1/study-plans`, {
      headers,
      data: { title: "E2E 期末复习", startDate: "2026-09-01", endDate: "2026-09-20", dailyAvailableMinutes: 30 },
    });
    expect(created.status()).toBe(201);
    planId = (await created.json()).id;

    const adjusted = await request.patch(`${baseURL}/v1/study-plans/${planId}`, {
      headers,
      data: { endDate: "2026-09-25", dailyAvailableMinutes: 45 },
    });
    expect(adjusted.status()).toBe(200);
    const adjustedBody = await adjusted.json();
    expect(adjustedBody).toMatchObject({ endDate: "2026-09-25", dailyAvailableMinutes: 45 });
    expect(adjustedBody.revisionCount).toBeGreaterThan(0);

    const predicted = await request.post(`${baseURL}/v1/study-plans/${planId}/prediction`, {
      headers,
      data: { prediction: "at_risk" },
    });
    expect(predicted.status()).toBe(200);
    expect((await predicted.json()).completionPrediction).toBe("at_risk");

    const archived = await request.post(`${baseURL}/v1/study-plans/${planId}/archive`, { headers });
    expect(archived.status()).toBe(200);
    expect((await archived.json()).status).toBe("archived");
  });
});
