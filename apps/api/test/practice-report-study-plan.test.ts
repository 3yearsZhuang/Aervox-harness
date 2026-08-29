/**
 * Aervox｜思隅 @aervox/api — 自适应刷题报告集成测试（CAP-016）
 *
 * 覆盖：
 * - 报告创建（区分观测与推断）
 * - 报告查询
 * - 重置推断（保留原始作答）
 * - 租户隔离
 *
 * 注：原 CAP-017 学习计划用例已随 study-plans 移除，学习规划由 learning-plan.test.ts 覆盖。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  type AervoxDatabase,
} from "@aervox/database";
import { buildApp } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_pr_it",
  "x-user-id": "usr_pr_it",
} as const;

const otherHeaders = {
  "x-workspace-id": "ws_other",
  "x-user-id": "usr_other",
} as const;

describe("自适应刷题报告（CAP-016）", () => {
  let app: FastifyInstance;
  let db: AervoxDatabase;
  let client: Client;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    db = res.db;
    client = res.client;
    cleanup = res.cleanup;
    const built = await buildApp({ db, client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("CAP-016：报告区分观测与推断", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/practice-reports",
      headers,
      payload: {
        sessionId: "sess_test_001",
        totalQuestions: 10,
        correctCount: 7,
        incorrectCount: 3,
        avgTimeSpentSec: 45,
        totalHintsUsed: 2,
        masteryPrediction: 0.72,
        biasAssessment: "slight_overestimate",
        reportType: "detailed",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.totalQuestions).toBe(10); // 观测
    expect(body.correctCount).toBe(7); // 观测
    expect(body.avgTimeSpentSec).toBe(45); // 观测
    expect(body.totalHintsUsed).toBe(2); // 观测
    expect(body.masteryPrediction).toBe(0.72); // 推断
    expect(body.biasAssessment).toBe("slight_overestimate"); // 推断
    expect(body.isReset).toBe(false);
  });

  it("CAP-016：按会话查询报告列表", async () => {
    const sessionId = "sess_list_001";
    // 创建多个报告
    await app.inject({
      method: "POST",
      url: "/v1/practice-reports",
      headers,
      payload: { sessionId, totalQuestions: 5, correctCount: 3, incorrectCount: 2 },
    });
    await app.inject({
      method: "POST",
      url: "/v1/practice-reports",
      headers,
      payload: { sessionId, totalQuestions: 8, correctCount: 6, incorrectCount: 2 },
    });

    const listRes = await app.inject({
      method: "GET",
      url: `/v1/practice-sessions/${sessionId}/reports`,
      headers,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items.length).toBe(2);
  });

  it("CAP-016：重置推断保留原始作答", async () => {
    const sessionId = "sess_reset_001";
    // 创建原始报告
    await app.inject({
      method: "POST",
      url: "/v1/practice-reports",
      headers,
      payload: {
        sessionId,
        totalQuestions: 10,
        correctCount: 7,
        incorrectCount: 3,
        masteryPrediction: 0.72,
      },
    });

    // 重置推断
    const resetRes = await app.inject({
      method: "POST",
      url: `/v1/practice-sessions/${sessionId}/reset-inference`,
      headers,
    });
    expect(resetRes.statusCode).toBe(201);
    const resetBody = resetRes.json();
    expect(resetBody.reportType).toBe("reset");
    expect(resetBody.isReset).toBe(true);
    expect(resetBody.masteryPrediction).toBeNull();

    // 原始报告仍存在
    const listRes = await app.inject({
      method: "GET",
      url: `/v1/practice-sessions/${sessionId}/reports`,
      headers,
    });
    expect(listRes.json().items.length).toBe(2); // 原始 + reset
  });

  it("租户隔离：不同工作区无法互相访问报告", async () => {
    const reportRes = await app.inject({
      method: "POST",
      url: "/v1/practice-reports",
      headers,
      payload: { sessionId: "sess_iso", totalQuestions: 5, correctCount: 3, incorrectCount: 2 },
    });
    const reportId = reportRes.json().id;

    // 其他租户无法获取报告
    const otherReport = await app.inject({
      method: "GET",
      url: `/v1/practice-reports/${reportId}`,
      headers: otherHeaders,
    });
    expect(otherReport.statusCode).toBe(404);
  });
});
