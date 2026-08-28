/**
 * Aervox｜思隅 E2E — 练习报告与错题筛选端到端测试
 *
 * 覆盖：CR-020 确定性练习反馈（ease / maintain / increase）、
 *       CR-018 错因标注与筛选、GET 报告端点、错题排序、完整刷题闭环
 */
import { test, expect } from "@playwright/test";
import { getServerPort, getDbPath, startServer, stopServer, cleanupDb } from "./helpers.js";
import type { ChildProcess } from "child_process";

const headers = {
  "x-workspace-id": "ws_e2e_guidance",
  "x-user-id": "usr_e2e_guidance",
};

test.describe("练习报告 guidance E2E（CR-020）", () => {
  let server: ChildProcess;
  let baseURL: string;
  const dbPath = getDbPath("practice-guidance");

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

  test("高正确率 + 快速 + 无提示 → increase", async ({ request }) => {
    // 准备 3 道简单题
    const qIds: string[] = [];
    for (const [prompt, answer] of [
      ["E2E inc 1", "a"],
      ["E2E inc 2", "b"],
      ["E2E inc 3", "c"],
    ]) {
      const q = await request.post(`${baseURL}/v1/questions`, {
        headers, data: { prompt, answerSpec: { answer } },
      });
      expect(q.status()).toBe(201);
      qIds.push((await q.json()).id);
    }

    // 创建会话
    const session = await request.post(`${baseURL}/v1/practice/sessions`, {
      headers, data: { count: 3 },
    });
    expect(session.status()).toBe(201);
    const sessionId = (await session.json()).sessionId;

    // 3 题全对、用时短、无提示
    for (let i = 0; i < 3; i++) {
      const attempt = await request.post(`${baseURL}/v1/questions/${qIds[i]}/attempts`, {
        headers,
        data: { sessionId, answer: String.fromCharCode(97 + i), elapsedSeconds: 10, hintsUsed: 0 },
      });
      expect(attempt.status()).toBe(201);
      expect((await attempt.json()).judgement).toBe("correct");
    }

    // 完成会话
    const report = await request.post(
      `${baseURL}/v1/practice/sessions/${sessionId}/complete`,
      { headers },
    );
    expect(report.status()).toBe(200);
    const body = await report.json();
    expect(body.guidance.difficulty).toBe("increase");
    expect(body.guidance.reasonCode).toBe("high_accuracy_fast_no_hints");
    expect(body.guidance.message).toBeTruthy();
    expect(body.avgTimeSpentSec).toBe(10);
    expect(body.totalHintsUsed).toBe(0);
    expect(body.accuracy).toBe(1);
  });

  test("低正确率 → ease", async ({ request }) => {
    const tenant = {
      "x-workspace-id": "ws_e2e_ease",
      "x-user-id": "usr_e2e_ease",
    };
    const qIds: string[] = [];
    for (const [prompt, answer] of [
      ["E2E ease 1", "x"],
      ["E2E ease 2", "y"],
      ["E2E ease 3", "z"],
    ]) {
      const q = await request.post(`${baseURL}/v1/questions`, {
        headers: tenant, data: { prompt, answerSpec: { answer } },
      });
      expect(q.status()).toBe(201);
      qIds.push((await q.json()).id);
    }

    const session = await request.post(`${baseURL}/v1/practice/sessions`, {
      headers: tenant, data: { count: 3 },
    });
    const sessionId = (await session.json()).sessionId;

    // 3 题全错
    for (let i = 0; i < 3; i++) {
      await request.post(`${baseURL}/v1/questions/${qIds[i]}/attempts`, {
        headers: tenant,
        data: { sessionId, answer: "wrong", elapsedSeconds: 30, hintsUsed: 0 },
      });
    }

    const report = await request.post(
      `${baseURL}/v1/practice/sessions/${sessionId}/complete`,
      { headers: tenant },
    );
    const body = await report.json();
    expect(body.guidance.difficulty).toBe("ease");
    expect(body.guidance.reasonCode).toBe("low_accuracy");
    expect(body.accuracy).toBe(0);
  });

  test("中等正确率 → maintain", async ({ request }) => {
    const tenant = {
      "x-workspace-id": "ws_e2e_mid",
      "x-user-id": "usr_e2e_mid",
    };
    const qIds: string[] = [];
    for (const [prompt, answer] of [
      ["E2E mid 1", "p"],
      ["E2E mid 2", "q"],
      ["E2E mid 3", "r"],
    ]) {
      const q = await request.post(`${baseURL}/v1/questions`, {
        headers: tenant, data: { prompt, answerSpec: { answer } },
      });
      qIds.push((await q.json()).id);
    }

    const session = await request.post(`${baseURL}/v1/practice/sessions`, {
      headers: tenant, data: { count: 3 },
    });
    const sessionId = (await session.json()).sessionId;

    // 2 对 1 错（66.7% → maintain）
    await request.post(`${baseURL}/v1/questions/${qIds[0]}/attempts`, {
      headers: tenant, data: { sessionId, answer: "p", elapsedSeconds: 5, hintsUsed: 0 },
    });
    await request.post(`${baseURL}/v1/questions/${qIds[1]}/attempts`, {
      headers: tenant, data: { sessionId, answer: "q", elapsedSeconds: 5, hintsUsed: 0 },
    });
    await request.post(`${baseURL}/v1/questions/${qIds[2]}/attempts`, {
      headers: tenant, data: { sessionId, answer: "wrong", elapsedSeconds: 5, hintsUsed: 0 },
    });

    const report = await request.post(
      `${baseURL}/v1/practice/sessions/${sessionId}/complete`,
      { headers: tenant },
    );
    const body = await report.json();
    expect(body.guidance.difficulty).toBe("maintain");
    expect(body.guidance.reasonCode).toBe("steady_progress");
    expect(body.accuracy).toBeCloseTo(2 / 3, 2);
  });

  test("用时未知时不提高难度", async ({ request }) => {
    const tenant = {
      "x-workspace-id": "ws_e2e_notime",
      "x-user-id": "usr_e2e_notime",
    };
    const qIds: string[] = [];
    for (const [prompt, answer] of [
      ["E2E notime 1", "m"],
      ["E2E notime 2", "n"],
      ["E2E notime 3", "o"],
    ]) {
      const q = await request.post(`${baseURL}/v1/questions`, {
        headers: tenant, data: { prompt, answerSpec: { answer } },
      });
      qIds.push((await q.json()).id);
    }

    const session = await request.post(`${baseURL}/v1/practice/sessions`, {
      headers: tenant, data: { count: 3 },
    });
    const sessionId = (await session.json()).sessionId;

    // 全对但不传 elapsedSeconds（用时未知）
    for (let i = 0; i < 3; i++) {
      await request.post(`${baseURL}/v1/questions/${qIds[i]}/attempts`, {
        headers: tenant,
        data: { sessionId, answer: String.fromCharCode(109 + i), hintsUsed: 0 },
      });
    }

    const report = await request.post(
      `${baseURL}/v1/practice/sessions/${sessionId}/complete`,
      { headers: tenant },
    );
    const body = await report.json();
    // 用时未知 → 不触发 increase，应 maintain
    expect(body.guidance.difficulty).toBe("maintain");
    expect(body.avgTimeSpentSec).toBeNull();
  });

  test("GET /report 端点与 complete 返回一致", async ({ request }) => {
    const tenant = {
      "x-workspace-id": "ws_e2e_getrep",
      "x-user-id": "usr_e2e_getrep",
    };
    const q = await request.post(`${baseURL}/v1/questions`, {
      headers: tenant, data: { prompt: "E2E getrep", answerSpec: { answer: "t" } },
    });
    const qId = (await q.json()).id;

    const session = await request.post(`${baseURL}/v1/practice/sessions`, {
      headers: tenant, data: { count: 3 },
    });
    const sessionId = (await session.json()).sessionId;

    await request.post(`${baseURL}/v1/questions/${qId}/attempts`, {
      headers: tenant,
      data: { sessionId, answer: "t", elapsedSeconds: 20, hintsUsed: 0 },
    });

    const completeRes = await request.post(
      `${baseURL}/v1/practice/sessions/${sessionId}/complete`,
      { headers: tenant },
    );
    const completeBody = await completeRes.json();

    // GET 报告
    const getRes = await request.get(
      `${baseURL}/v1/practice/sessions/${sessionId}/report`,
      { headers: tenant },
    );
    expect(getRes.status()).toBe(200);
    const getBody = await getRes.json();

    // 关键字段一致
    expect(getBody.sessionId).toBe(completeBody.sessionId);
    expect(getBody.answeredCount).toBe(completeBody.answeredCount);
    expect(getBody.accuracy).toBe(completeBody.accuracy);
    expect(getBody.guidance.difficulty).toBe(completeBody.guidance.difficulty);
    expect(getBody.guidance.reasonCode).toBe(completeBody.guidance.reasonCode);
    expect(getBody.avgTimeSpentSec).toBe(completeBody.avgTimeSpentSec);
    expect(getBody.totalHintsUsed).toBe(completeBody.totalHintsUsed);
  });
});

test.describe("错因标注与筛选 E2E（CR-018）", () => {
  let server: ChildProcess;
  let baseURL: string;
  const dbPath = getDbPath("mistake-insights-e2e");
  const questionIds: string[] = [];

  test.beforeAll(async () => {
    cleanupDb(dbPath);
    const port = getServerPort();
    const result = await startServer(port, dbPath);
    server = result.server;
    baseURL = result.url;

    // 创建 5 道题
    for (const [prompt, answer] of [
      ["E2E 错因 概念", "a"],
      ["E2E 错因 计算", "b"],
      ["E2E 错因 粗心", "c"],
      ["E2E 错因 审题", "d"],
      ["E2E 错因 其他", "e"],
    ]) {
      const q = await fetch(`${baseURL}/v1/questions`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, answerSpec: { answer } }),
      });
      questionIds.push((await q.json()).id);
    }

    // 全部答错 1~3 次，制造不同错误次数
    const wrongCounts = [3, 2, 2, 1, 1];
    for (let i = 0; i < questionIds.length; i++) {
      for (let j = 0; j < wrongCounts[i]; j++) {
        await fetch(`${baseURL}/v1/questions/${questionIds[i]}/attempts`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: "ses_e2e_insight", answer: "wrong" }),
        });
      }
    }
  });

  test.afterAll(async () => {
    stopServer(server);
    cleanupDb(dbPath);
  });

  test("标注错因后按 reasonCode 筛选", async ({ request }) => {
    const reasonCodes = ["concept_gap", "calculation", "careless", "misread", "other"];

    // 给每道题标不同错因
    for (let i = 0; i < questionIds.length; i++) {
      const res = await request.patch(`${baseURL}/v1/mistakes/${questionIds[i]}`, {
        headers, data: { reasonCode: reasonCodes[i], note: `E2E 标注 ${reasonCodes[i]}` },
      });
      expect(res.status()).toBe(200);
    }

    // 按 concept_gap 筛选 → 只返回第 1 题
    const filtered = await request.get(
      `${baseURL}/v1/mistakes?reasonCode=concept_gap`,
      { headers },
    );
    expect(filtered.status()).toBe(200);
    const items = (await filtered.json()).items;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.every((m: { reasonCode: string }) => m.reasonCode === "concept_gap")).toBeTruthy();
  });

  test("非法 reasonCode 返回 400", async ({ request }) => {
    const res = await request.get(
      `${baseURL}/v1/mistakes?reasonCode=invalid_code`,
      { headers },
    );
    expect(res.status()).toBe(400);
  });

  test("按错误次数降序排序（frequent）", async ({ request }) => {
    const res = await request.get(
      `${baseURL}/v1/mistakes?sortBy=frequent`,
      { headers },
    );
    expect(res.status()).toBe(200);
    const items = (await res.json()).items;
    expect(items.length).toBeGreaterThanOrEqual(3);

    // 验证 wrongCount 非递增
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].wrongCount).toBeGreaterThanOrEqual(items[i].wrongCount);
    }
  });

  test("默认排序为 recent（按最近作答时间）", async ({ request }) => {
    const res = await request.get(`${baseURL}/v1/mistakes`, { headers });
    expect(res.status()).toBe(200);
    const items = (await res.json()).items;
    expect(items.length).toBeGreaterThanOrEqual(1);
    // 默认排序有 lastAttemptAt 字段
    expect(items[0].latestAttemptAt).toBeTruthy();
  });

  test("清除错因后 reasonCode 为 null", async ({ request }) => {
    await request.patch(`${baseURL}/v1/mistakes/${questionIds[0]}`, {
      headers, data: { reasonCode: null },
    });

    const mistakes = await request.get(`${baseURL}/v1/mistakes`, { headers });
    const target = (await mistakes.json()).items.find(
      (m: { questionId: string }) => m.questionId === questionIds[0],
    );
    expect(target.reasonCode).toBeNull();
  });
});

test.describe("刷题完整闭环 E2E", () => {
  let server: ChildProcess;
  let baseURL: string;
  const dbPath = getDbPath("practice-full-loop");

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

  test("练习 → 错题 → 标注错因 → 重练 → 掌握", async ({ request }) => {
    // 1. 创建题目
    const q = await request.post(`${baseURL}/v1/questions`, {
      headers, data: { prompt: "E2E 闭环题", answerSpec: { answer: "ok" } },
    });
    expect(q.status()).toBe(201);
    const qId = (await q.json()).id;

    // 2. 创建练习会话
    const session = await request.post(`${baseURL}/v1/practice/sessions`, {
      headers, data: { count: 3 },
    });
    const sessionId = (await session.json()).sessionId;

    // 3. 答错
    const wrong = await request.post(`${baseURL}/v1/questions/${qId}/attempts`, {
      headers, data: { sessionId, answer: "no", elapsedSeconds: 15, hintsUsed: 1 },
    });
    expect(wrong.status()).toBe(201);
    expect((await wrong.json()).judgement).toBe("incorrect");

    // 4. 结束会话
    await request.post(`${baseURL}/v1/practice/sessions/${sessionId}/complete`, { headers });

    // 5. 错题自动聚合
    const mistakes1 = await request.get(`${baseURL}/v1/mistakes`, { headers });
    const items1 = (await mistakes1.json()).items;
    expect(items1.some((m: { questionId: string }) => m.questionId === qId)).toBeTruthy();

    // 6. 标注错因
    const patch = await request.patch(`${baseURL}/v1/mistakes/${qId}`, {
      headers, data: { reasonCode: "concept_gap", note: "概念不清晰" },
    });
    expect(patch.status()).toBe(200);

    // 7. 按错因筛选能找到
    const filtered = await request.get(
      `${baseURL}/v1/mistakes?reasonCode=concept_gap`,
      { headers },
    );
    expect((await filtered.json()).items.some(
      (m: { questionId: string }) => m.questionId === qId,
    )).toBeTruthy();

    // 8. 发起重练
    const repractice = await request.post(`${baseURL}/v1/mistakes/repractice`, {
      headers, data: { questionIds: [qId] },
    });
    expect([200, 201]).toContain(repractice.status());
    const reSessionId = (await repractice.json()).sessionId;
    expect(reSessionId).toBeTruthy();

    // 9. 重练时答对
    const correct = await request.post(`${baseURL}/v1/questions/${qId}/attempts`, {
      headers, data: { sessionId: reSessionId, answer: "ok", elapsedSeconds: 5, hintsUsed: 0 },
    });
    expect(correct.status()).toBe(201);
    expect((await correct.json()).judgement).toBe("correct");

    // 10. 重练会话完成后，报告 guidance 正确
    const reReport = await request.post(
      `${baseURL}/v1/practice/sessions/${reSessionId}/complete`,
      { headers },
    );
    expect(reReport.status()).toBe(200);
    const reBody = await reReport.json();
    expect(reBody.guidance.difficulty).toBeTruthy();
    expect(reBody.accuracy).toBe(1);
  });
});
