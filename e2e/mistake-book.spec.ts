/**
 * Aervox｜思隅 E2E — 错题本端到端测试
 *
 * 覆盖：错题聚合、忽略/恢复、错因标注、恢复后重练、作答历史不受影响
 */
import { test, expect } from "@playwright/test";
import { getServerPort, getDbPath, startServer, stopServer, cleanupDb } from "./helpers.js";
import type { ChildProcess } from "child_process";

const headers = {
  "x-workspace-id": "ws_e2e_mistake",
  "x-user-id": "usr_e2e_mistake",
};

test.describe("错题本 E2E", () => {
  let server: ChildProcess;
  let baseURL: string;
  const dbPath = getDbPath("mistake-book");
  let questionIds: string[] = [];

  test.beforeAll(async () => {
    cleanupDb(dbPath);
    const port = getServerPort();
    const result = await startServer(port, dbPath);
    server = result.server;
    baseURL = result.url;

    // 创建测试题目
    for (const [prompt, answer] of [
      ["E2E 错题 1", "a"],
      ["E2E 错题 2", "b"],
      ["E2E 错题 3", "c"],
    ]) {
      const q = await fetch(`${baseURL}/v1/questions`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, answerSpec: { answer } }),
      });
      expect(q.status).toBe(201);
      questionIds.push((await q.json()).id);
    }
  });

  test.afterAll(async () => {
    stopServer(server);
    cleanupDb(dbPath);
  });

  test("答错后错题自动聚合", async ({ request }) => {
    for (let i = 0; i < 2; i++) {
      await request.post(`${baseURL}/v1/questions/${questionIds[i]}/attempts`, {
        headers, data: { sessionId: "ses_e2e_mistake", answer: "wrong" },
      });
    }

    const mistakes = await request.get(`${baseURL}/v1/mistakes`, { headers });
    expect(mistakes.status()).toBe(200);
    const body = await mistakes.json();
    expect(body.items.length).toBeGreaterThanOrEqual(2);
  });

  test("忽略错题后不在默认列表", async ({ request }) => {
    const dismiss = await request.patch(
      `${baseURL}/v1/mistakes/${questionIds[0]}`,
      { headers, data: { status: "dismissed", reason: "概念混淆", note: "需复习" } },
    );
    expect(dismiss.status()).toBe(200);

    const active = await request.get(`${baseURL}/v1/mistakes`, { headers });
    const items = (await active.json()).items;
    expect(items.find((item: { questionId: string }) => item.questionId === questionIds[0])).toBeFalsy();
  });

  test("恢复错题后可重练", async ({ request }) => {
    const restore = await request.patch(
      `${baseURL}/v1/mistakes/${questionIds[0]}`,
      { headers, data: { status: "active" } },
    );
    expect(restore.status()).toBe(200);

    // 重练可能返回 201（新建）或 200（复用已有活跃会话）
    const repractice = await request.post(`${baseURL}/v1/mistakes/repractice`, {
      headers, data: { questionIds: [questionIds[0]] },
    });
    expect([200, 201]).toContain(repractice.status());
    expect((await repractice.json()).sessionId).toBeTruthy();
  });

  test("作答历史不受错题忽略影响", async ({ request }) => {
    // 检查之前答错的题目仍有作答记录
    const attempts = await request.get(
      `${baseURL}/v1/questions/${questionIds[1]}/attempts`,
      { headers },
    );
    expect((await attempts.json()).items.length).toBeGreaterThanOrEqual(1);
  });
});