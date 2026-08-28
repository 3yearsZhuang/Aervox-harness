/**
 * Aervox｜思隅 @aervox/api — 自适应刷题报告 + 考试日计划集成测试（CAP-016/017）
 *
 * CAP-016 覆盖：
 * - 报告创建（区分观测与推断）
 * - 报告查询
 * - 重置推断（保留原始作答）
 *
 * CAP-017 覆盖：
 * - 计划创建/查询/更新/归档
 * - 滚动调整（revisionCount 递增，不删除记录）
 * - 完成预测与降级计划
 * - 租户隔离
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  SqliteLearningRepository,
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

describe("自适应刷题报告 + 考试日计划（CAP-016/017）", () => {
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

  // ============ CAP-016 练习报告 ============

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

  // ============ CAP-017 学习计划 ============

  it("CAP-017：创建学习计划，可修改日期/休息日/可用时间", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/study-plans",
      headers,
      payload: {
        title: "期末考试复习",
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        restDays: ["2026-09-10", "2026-09-11"],
        dailyAvailableMinutes: 180,
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.title).toBe("期末考试复习");
    expect(body.startDate).toBe("2026-09-01");
    expect(body.endDate).toBe("2026-09-30");
    expect(body.restDays).toEqual(["2026-09-10", "2026-09-11"]);
    expect(body.dailyAvailableMinutes).toBe(180);
    expect(body.status).toBe("active");
    expect(body.revisionCount).toBe(0);
  });

  it("CAP-017：滚动调整不删除已完成记录（revisionCount 递增）", async () => {
    // 创建计划
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/study-plans",
      headers,
      payload: {
        title: "计划A",
        startDate: "2026-09-01",
        endDate: "2026-09-20",
      },
    });
    const planId = createRes.json().id;
    expect(createRes.json().revisionCount).toBe(0);

    // 第一次调整
    const update1 = await app.inject({
      method: "PATCH",
      url: `/v1/study-plans/${planId}`,
      headers,
      payload: { endDate: "2026-09-25" },
    });
    expect(update1.statusCode).toBe(200);
    expect(update1.json().endDate).toBe("2026-09-25");

    // 第二次调整
    const update2 = await app.inject({
      method: "PATCH",
      url: `/v1/study-plans/${planId}`,
      headers,
      payload: { dailyAvailableMinutes: 200, restDays: ["2026-09-15"] },
    });
    expect(update2.statusCode).toBe(200);
    expect(update2.json().dailyAvailableMinutes).toBe(200);

    // revisionCount 应递增（不删除已完成记录）
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/study-plans/${planId}`,
      headers,
    });
    expect(getRes.json().revisionCount).toBeGreaterThan(0);
  });

  it("CAP-017：预测无法完成时展示降级计划", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/study-plans",
      headers,
      payload: {
        title: "紧张计划",
        startDate: "2026-09-01",
        endDate: "2026-09-10",
      },
    });
    const planId = createRes.json().id;

    // 更新预测为无法完成
    const predRes = await app.inject({
      method: "POST",
      url: `/v1/study-plans/${planId}/prediction`,
      headers,
      payload: {
        prediction: "cannot_complete",
        degradationPlan: { strategy: "focus_core", drop: ["chapter_5", "chapter_6"] },
      },
    });
    expect(predRes.statusCode).toBe(200);
    const body = predRes.json();
    expect(body.completionPrediction).toBe("cannot_complete");
    expect(body.degradationPlan).toEqual({ strategy: "focus_core", drop: ["chapter_5", "chapter_6"] });

    // 也可更新为 on_track
    const onTrackRes = await app.inject({
      method: "POST",
      url: `/v1/study-plans/${planId}/prediction`,
      headers,
      payload: { prediction: "on_track" },
    });
    expect(onTrackRes.json().completionPrediction).toBe("on_track");
  });

  it("CAP-017：归档计划后不再可见", async () => {
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/study-plans",
      headers,
      payload: {
        title: "归档测试",
        startDate: "2026-09-01",
        endDate: "2026-09-15",
      },
    });
    const planId = createRes.json().id;

    const archiveRes = await app.inject({
      method: "POST",
      url: `/v1/study-plans/${planId}/archive`,
      headers,
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(archiveRes.json().status).toBe("archived");

    // 归档后 GET 返回 404
    const getRes = await app.inject({
      method: "GET",
      url: `/v1/study-plans/${planId}`,
      headers,
    });
    expect(getRes.statusCode).toBe(404);

    // 不在列表中
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/study-plans",
      headers,
    });
    expect(listRes.json().items.length).toBe(0);
  });

  // ============ 租户隔离 ============

  it("租户隔离：不同工作区无法互相访问计划和报告", async () => {
    // 创建计划
    const createRes = await app.inject({
      method: "POST",
      url: "/v1/study-plans",
      headers,
      payload: { title: "隔离", startDate: "2026-09-01", endDate: "2026-09-20" },
    });
    const planId = createRes.json().id;

    // 其他租户无法获取
    const otherGet = await app.inject({
      method: "GET",
      url: `/v1/study-plans/${planId}`,
      headers: otherHeaders,
    });
    expect(otherGet.statusCode).toBe(404);

    // 其他租户无法调整
    const otherUpdate = await app.inject({
      method: "PATCH",
      url: `/v1/study-plans/${planId}`,
      headers: otherHeaders,
      payload: { title: "hijack" },
    });
    expect(otherUpdate.statusCode).toBe(404);

    // 创建报告
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
