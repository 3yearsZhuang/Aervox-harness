/**
 * Aervox｜思隅 @aervox/api — 学习模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import type { ModuleDependencies } from "../../context.js";
import { SqliteLearningRepository } from "@aervox/repositories";
import { registerLearningRoutes } from "./routes.js";
import { registerLearningPlanRoutes } from "./plan-routes.js";
import { LearningPlanGenerationService, createLlmPlanModelPort } from "./plan-generation.js";

export function registerLearningModule(ctx: ModuleDependencies<"app" | "db" | "llmConfigService">): void {
  const { app, db } = ctx;
  const learningRepo = new SqliteLearningRepository(db);
  registerLearningRoutes(app, learningRepo);
  // CR-060：CAP-016 报告路由已由第一方插件以 PluginHttpEndpoint 贡献（见 apps/api/src/plugin-assembly.ts）

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