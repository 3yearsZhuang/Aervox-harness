/**
 * Aervox｜思隅 @aervox/api — 自适应刷题报告 + 考试日计划路由（P1 · CAP-016/017）
 *
 * CAP-016 覆盖：
 * - 练习报告创建（区分观测与推断）
 * - 报告查询
 * - 重置推断（保留原始作答）
 *
 * CAP-017 覆盖：
 * - 学习计划创建/查询/更新/归档
 * - 滚动调整（不删除已完成记录）
 * - 完成预测与降级计划
 */
import type { FastifyInstance } from "fastify";
import type { SqliteLearningRepository } from "@aervox/database";
import {
  createPracticeReportSchema,
  createStudyPlanSchema,
  updateStudyPlanSchema,
  updatePredictionSchema,
} from "@aervox/contracts";
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

  // ============ CAP-017 学习计划 ============

  // POST /v1/study-plans — 创建学习计划
  app.post("/v1/study-plans", async (req, reply) => {
    const tenant = resolveTenant(req);
    const parsed = createStudyPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const plan = await learningRepo.createStudyPlan(tenant, {
      id: nextId("sp"),
      goalId: parsed.data.goalId,
      title: parsed.data.title,
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
      restDays: parsed.data.restDays,
      dailyAvailableMinutes: parsed.data.dailyAvailableMinutes,
    });
    return reply.status(201).send(plan);
  });

  // GET /v1/study-plans — 列出计划
  app.get("/v1/study-plans", async (req, reply) => {
    const tenant = resolveTenant(req);
    const items = await learningRepo.listStudyPlans(tenant);
    return reply.send({ items });
  });

  // GET /v1/study-plans/:id — 获取计划
  app.get("/v1/study-plans/:planId", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { planId } = req.params as { planId: string };
    const plan = await learningRepo.getStudyPlan(tenant, planId);
    if (!plan) {
      return reply.status(404).send({ error: "Plan not found" });
    }
    return reply.send(plan);
  });

  // PATCH /v1/study-plans/:id — 滚动调整
  app.patch("/v1/study-plans/:planId", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { planId } = req.params as { planId: string };
    const parsed = updateStudyPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const updated = await learningRepo.updateStudyPlan(tenant, planId, parsed.data);
    if (!updated) {
      return reply.status(404).send({ error: "Plan not found" });
    }
    return reply.send(updated);
  });

  // POST /v1/study-plans/:id/prediction — 更新完成预测
  app.post("/v1/study-plans/:planId/prediction", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { planId } = req.params as { planId: string };
    const parsed = updatePredictionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const updated = await learningRepo.updateCompletionPrediction(
      tenant,
      planId,
      parsed.data.prediction,
      parsed.data.degradationPlan,
    );
    if (!updated) {
      return reply.status(404).send({ error: "Plan not found" });
    }
    return reply.send(updated);
  });

  // POST /v1/study-plans/:id/archive — 归档计划
  app.post("/v1/study-plans/:planId/archive", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { planId } = req.params as { planId: string };
    const archived = await learningRepo.archiveStudyPlan(tenant, planId);
    if (!archived) {
      return reply.status(404).send({ error: "Plan not found" });
    }
    return reply.send(archived);
  });
}
