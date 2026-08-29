/**
 * Aervox｜思隅 @aervox/api — 自适应刷题报告路由（P1 · CAP-016）
 *
 * CAP-016 覆盖：
 * - 练习报告创建（区分观测与推断）
 * - 报告查询
 * - 重置推断（保留原始作答）
 *
 * 原 CAP-017 学习计划路由已被「学习规划」（OpenMAIC planner 单次结构化生成）替换，见 plan-routes.ts。
 */
import type { FastifyInstance } from "fastify";
import type { SqliteLearningRepository } from "@aervox/database";
import { createPracticeReportSchema } from "@aervox/contracts";
import { resolveTenant } from "../../shared/tenant.js";

let seq = 0;
const nextId = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export function registerCap016017Routes(
  app: FastifyInstance,
  learningRepo: SqliteLearningRepository,
): void {
  // ============ CAP-016 练习报告 ============

  // POST /v1/practice-reports — 创建练习报告
  app.post("/v1/practice-reports", async (req, reply) => {
    const tenant = resolveTenant(req);
    const parsed = createPracticeReportSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const report = await learningRepo.createPracticeReport(tenant, {
      id: nextId("rpt"),
      sessionId: parsed.data.sessionId,
      totalQuestions: parsed.data.totalQuestions,
      correctCount: parsed.data.correctCount,
      incorrectCount: parsed.data.incorrectCount,
      avgTimeSpentSec: parsed.data.avgTimeSpentSec,
      totalHintsUsed: parsed.data.totalHintsUsed,
      masteryPrediction: parsed.data.masteryPrediction,
      biasAssessment: parsed.data.biasAssessment,
      reportType: parsed.data.reportType,
    });
    return reply.status(201).send(report);
  });

  // GET /v1/practice-reports/:id — 获取报告
  app.get("/v1/practice-reports/:reportId", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { reportId } = req.params as { reportId: string };
    const report = await learningRepo.getPracticeReport(tenant, reportId);
    if (!report) {
      return reply.status(404).send({ error: "Report not found" });
    }
    return reply.send(report);
  });

  // GET /v1/practice-sessions/:sessionId/reports — 按会话查报告
  app.get("/v1/practice-sessions/:sessionId/reports", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { sessionId } = req.params as { sessionId: string };
    const items = await learningRepo.listPracticeReports(tenant, sessionId);
    return reply.send({ items });
  });

  // POST /v1/practice-sessions/:sessionId/reset-inference — 重置推断
  app.post("/v1/practice-sessions/:sessionId/reset-inference", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { sessionId } = req.params as { sessionId: string };
    const report = await learningRepo.resetMasteryInference(tenant, sessionId);
    return reply.status(201).send(report);
  });
}
