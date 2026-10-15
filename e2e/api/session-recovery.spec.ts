/**
 * Aervox｜思隅 E2E — 练习会话恢复端到端测试
 *
 * 覆盖：恢复未结束会话、重复启动复用、幂等重试、结束会话禁止作答
 */
import { test, expect } from "@playwright/test";
import { getServerPort, getDbPath, startServer, stopServer, cleanupDb } from "./helpers.js";
import type { ChildProcess } from "child_process";

const headers = {
  "x-workspace-id": "ws_e2e_rec",
  "x-user-id": "usr_e2e_rec",
};

test.describe("练习会话恢复 E2E", () => {
  let server: ChildProcess;
  let baseURL: string;
  const dbPath = getDbPath("session-recovery");
  let sessionId: string;
  let questionIds: string[] = [];

  test.beforeAll(async () => {
    cleanupDb(dbPath);
    const port = getServerPort();
    const result = await startServer(port, dbPath);
    server = result.server;
    baseURL = result.url;

    // 创建测试题目
    for (const [prompt, answer] of [
      ["E2E 恢复 1", "x"],
      ["E2E 恢复 2", "y"],
      ["E2E 恢复 3", "z"],
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

  test("1. 创建练习会话", async ({ request }) => {
    const res = await request.post(`${baseURL}/v1/practice/sessions`, {
      headers, data: { count: 3 },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    sessionId = body.sessionId;
    expect(body.answeredQuestionIds).toEqual([]);
    expect(body.nextQuestionIndex).toBe(0);
  });

  test("2. 恢复活跃会话", async ({ request }) => {
    // 答对第一题
    await request.post(`${baseURL}/v1/questions/${questionIds[0]}/attempts`, {
      headers, data: { sessionId, answer: "x" },
    });

    const active = await request.get(`${baseURL}/v1/practice/sessions/active`, {
      headers,
    });
    expect(active.status()).toBe(200);
    const body = await active.json();
    expect(body.sessionId).toBe(sessionId);
    expect(body.answeredQuestionIds).toEqual([questionIds[0]]);
    expect(body.nextQuestionIndex).toBe(1);
    expect(body.items.map((item: { id: string }) => item.id)).toEqual(questionIds);
  });

  test("3. 重复启动返回既有会话", async ({ request }) => {
    const retry = await request.post(`${baseURL}/v1/practice/sessions`, {
      headers, data: { count: 5 },
    });
    expect(retry.status()).toBe(200);
    expect((await retry.json()).sessionId).toBe(sessionId);
  });

  test("4. 幂等键重试不重复提交", async ({ request }) => {
    const idemHeaders = { ...headers, "idempotency-key": "e2e_rec_retry1" };
    const first = await request.post(
      `${baseURL}/v1/questions/${questionIds[1]}/attempts`,
      { headers: idemHeaders, data: { sessionId, answer: "y" } },
    );
    expect(first.status()).toBe(201);

    const retry = await request.post(
      `${baseURL}/v1/questions/${questionIds[1]}/attempts`,
      { headers: idemHeaders, data: { sessionId, answer: "y" } },
    );
    expect(retry.status()).toBe(200);

    const attempts = await request.get(
      `${baseURL}/v1/questions/${questionIds[1]}/attempts`,
      { headers },
    );
    expect((await attempts.json()).items).toHaveLength(1);
  });

  test("5. 完成会话后禁止作答", async ({ request }) => {
    await request.post(
      `${baseURL}/v1/practice/sessions/${sessionId}/complete`,
      { headers },
    );

    const after = await request.post(
      `${baseURL}/v1/questions/${questionIds[2]}/attempts`,
      { headers, data: { sessionId, answer: "z" } },
    );
    expect(after.status()).toBe(409);
  });

  test("6. 完成后活跃会话返回 404", async ({ request }) => {
    const active = await request.get(`${baseURL}/v1/practice/sessions/active`, {
      headers,
    });
    expect(active.status()).toBe(404);
  });
});

test.describe("边界案例", () => {
  let server: ChildProcess;
  let baseURL: string;
  const dbPath = getDbPath("session-recovery-edge");

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

  test("不存在的活跃会话返回 404", async ({ request }) => {
    const res = await request.get(`${baseURL}/v1/practice/sessions/active`, {
      headers: { "x-workspace-id": "ws_none", "x-user-id": "usr_none" },
    });
    expect(res.status()).toBe(404);
  });
});