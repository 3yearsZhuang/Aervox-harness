/**
 * Aervox｜思隅 @aervox/api — 学习规划路由（参考 OpenMAIC planner 单次结构化生成）
 *
 * 生成（单次 LLM 调用内完成）/ 列表 / 详情 / 任务勾选（含里程碑推进）/ 归档。
 */
import type { FastifyInstance } from "fastify";
import type { SqliteLearningRepository } from "@aervox/database";
import { generateLearningPlanSchema, updatePlanTaskStatusSchema } from "@aervox/contracts";
import { resolveTenant } from "../../shared/tenant.js";
import type { LearningPlanGenerationService } from "./plan-generation.js";

export function registerLearningPlanRoutes(
  app: FastifyInstance,
  learningRepo: SqliteLearningRepository,
  planGeneration: LearningPlanGenerationService,
): void {
  // POST /v1/learning-plans/generate — AI 生成学习规划并落库
  app.post("/v1/learning-plans/generate", async (req, reply) => {
    const tenant = resolveTenant(req);
    const parsed = generateLearningPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    try {
      const { plan, generatedBy } = await planGeneration.generate(tenant, {
        topic: parsed.data.topic,
        level: parsed.data.level,
        dailyMinutes: parsed.data.dailyMinutes,
      });
      return reply.status(201).send({ ...plan, generatedBy });
    } catch (error) {
      const message = error instanceof Error ? error.message : "学习规划生成失败";
      if (message.startsWith("llm_")) {
        return reply.status(400).send({ error: message });
      }
      if (message.startsWith("plan_generation_failed:")) {
        return reply.status(502).send({ error: message });
      }
      throw error;
    }
  });

  // GET /v1/learning-plans — 列出学习规划（?includeArchived=true 可选）
  app.get("/v1/learning-plans", async (req, reply) => {
    const tenant = resolveTenant(req);
    const includeArchived =
      (req.query as Record<string, unknown> | undefined)?.includeArchived === "true";
    const items = await learningRepo.listLearningPlans(tenant, includeArchived);
    return reply.send({ items });
  });

  // GET /v1/learning-plans/:planId — 获取规划详情
  app.get("/v1/learning-plans/:planId", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { planId } = req.params as { planId: string };
    const plan = await learningRepo.getLearningPlan(tenant, planId);
    if (!plan) {
      return reply.status(404).send({ error: "Plan not found" });
    }
    return reply.send(plan);
  });

  // PATCH /v1/plan-tasks/:taskId — 更新任务状态（返回更新后的完整规划，含里程碑推进）
  app.patch("/v1/plan-tasks/:taskId", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { taskId } = req.params as { taskId: string };
    const parsed = updatePlanTaskStatusSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Validation failed", details: parsed.error.issues });
    }

    const plan = await learningRepo.setPlanTaskStatus(tenant, taskId, parsed.data.status);
    if (!plan) {
      return reply.status(404).send({ error: "Task not found" });
    }
    return reply.send(plan);
  });

  // POST /v1/learning-plans/:planId/archive — 归档学习规划
  app.post("/v1/learning-plans/:planId/archive", async (req, reply) => {
    const tenant = resolveTenant(req);
    const { planId } = req.params as { planId: string };
    const archived = await learningRepo.archiveLearningPlan(tenant, planId);
    if (!archived) {
      return reply.status(404).send({ error: "Plan not found" });
    }
    return reply.send(archived);
  });
}
