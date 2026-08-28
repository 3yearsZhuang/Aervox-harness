/**
 * Aervox｜思隅 E2E — 练习流程端到端测试
 *
 * 覆盖：创建学习目标 → 创建题目 → 练习会话 → 答题 → 报告 → 错题自动聚合 → 租户隔离
 */
import { test, expect } from "@playwright/test";
import { getServerPort, getDbPath, startServer, stopServer, cleanupDb } from "./helpers.js";
import type { ChildProcess } from "child_process";

const headers = { "x-workspace-id": "ws_e2e_flow", "x-user-id": "usr_e2e_flow" };

test.describe("练习流程端到端", () => {
  let server: ChildProcess;
  let baseURL: string;
  const dbPath = getDbPath("practice-flow");
  let goalId: string;
  let questionIds: string[] = [];
  let sessionId: string;

  test.beforeAll(async () => {
    cleanupDb(dbPath);
    const port = getServerPort();
    const result = await startServer(port, dbPath);
    server = result.server;
    baseURL = result.url;
  });

  test.afterAll(async () => {
    stopServer(server);
    cleanupDb(dbPath);
  });

  test.beforeEach(async ({ request }) => {
    // 确保 baseURL 已设置
    if (!baseURL) return;
  });

  test("1. 创建学习目标", async ({ request }) => {
    const goal = await request.post(`${baseURL}/v1/learning/goals`, {
      headers, data: { topic: "E2E 三角函数", level: "intermediate", availableMinutes: 20 },
    });
    expect(goal.status()).toBe(201);
    goalId = (await goal.json()).id;
  });

  test("2. 创建题目", async ({ request }) => {
    for (const [prompt, answer] of [
      ["sin(0) = ?", "0"],
      ["cos(0) = ?", "1"],
      ["tan(0) = ?", "0"],
    ]) {
      const q = await request.post(`${baseURL}/v1/questions`, {
        headers, data: { prompt, answerSpec: { answer } },
      });
      expect(q.status()).toBe(201);
      questionIds.push((await q.json()).id);
    }
    expect(questionIds).toHaveLength(3);
  });

  test("3. 创建练习会话", async ({ request }) => {
    expect(questionIds).toHaveLength(3);
    const res = await request.post(`${baseURL}/v1/practice/sessions`, {
      headers, data: { count: 3 },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.sessionId).toBeTruthy();
    expect(body.items).toHaveLength(3);
    expect(body.answeredQuestionIds).toEqual([]);
    expect(body.nextQuestionIndex).toBe(0);
    sessionId = body.sessionId;
  });

  test("4. 逐题作答", async ({ request }) => {
    expect(sessionId).toBeTruthy();
    expect(questionIds.length).toBeGreaterThanOrEqual(2);

    const correct = await request.post(`${baseURL}/v1/questions/${questionIds[0]}/attempts`, {
      headers, data: { sessionId, answer: "0" },
    });
    expect(correct.status()).toBe(201);
    expect((await correct.json()).judgement).toBe("correct");

    const wrong = await request.post(`${baseURL}/v1/questions/${questionIds[1]}/attempts`, {
      headers, data: { sessionId, answer: "wrong" },
    });
    expect(wrong.status()).toBe(201);
    expect((await wrong.json()).judgement).toBe("incorrect");
  });

  test("5. 生成练习报告", async ({ request }) => {
    expect(sessionId).toBeTruthy();
    const report = await request.post(
      `${baseURL}/v1/practice/sessions/${sessionId}/complete`,
      { headers },
    );
    expect(report.status()).toBe(200);
    const body = await report.json();
    expect(body.sessionId).toBe(sessionId);
    expect(body.answeredCount).toBe(2);
    expect(body.remainingCount).toBe(1);
    expect(body.accuracy).toBe(0.5);
  });

  test("6. 已结束会话拒绝作答", async ({ request }) => {
    expect(sessionId).toBeTruthy();
    expect(questionIds.length).toBeGreaterThanOrEqual(3);

    const after = await request.post(
      `${baseURL}/v1/questions/${questionIds[2]}/attempts`,
      { headers, data: { sessionId, answer: "0" } },
    );
    expect(after.status()).toBe(409);
  });

  test("7. 错题自动聚合", async ({ request }) => {
    const mistakes = await request.get(`${baseURL}/v1/mistakes`, { headers });
    expect(mistakes.status()).toBe(200);
    const body = await mistakes.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
    expect(body.items.some((m: { questionId: string }) => m.questionId === questionIds[1])).toBeTruthy();
  });

  test("8. 租户隔离", async ({ request }) => {
    const other = { "x-workspace-id": "ws_other", "x-user-id": "usr_other" };
    const goals = await request.get(`${baseURL}/v1/learning/goals`, { headers: other });
    expect((await goals.json()).items).toHaveLength(0);
    const mistakes = await request.get(`${baseURL}/v1/mistakes`, { headers: other });
    expect((await mistakes.json()).items).toHaveLength(0);
  });
});