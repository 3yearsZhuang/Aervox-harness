/**
 * Aervox｜思隅 @aervox/api — 学习模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import type { ModuleContext } from "../context.js";
import { SqliteLearningRepository } from "@aervox/database";
import { registerLearningRoutes } from "./routes.js";
import { registerCap016017Routes } from "./cap016-017-routes.js";
import { registerLearningPlanRoutes } from "./plan-routes.js";
import { LearningPlanGenerationService, createLlmPlanModelPort } from "./plan-generation.js";

export function registerLearningModule(ctx: ModuleContext): void {
  const { app, db } = ctx;
  const learningRepo = new SqliteLearningRepository(db);
  registerLearningRoutes(app, learningRepo);
  registerCap016017Routes(app, learningRepo);

  // 学习规划生成：llm 模式走 LLM 端口；llm 模块未接线或非 llm 模式由服务内模板降级/抛错
  const planGeneration = new LearningPlanGenerationService({
    db,
    learningRepo,
    model: ctx.llmConfigService
      ? createLlmPlanModelPort(ctx.llmConfigService)
      : (undefined as never),
  });
  registerLearningPlanRoutes(app, learningRepo, planGeneration);
}