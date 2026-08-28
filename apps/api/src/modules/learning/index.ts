/**
 * Aervox｜思隅 @aervox/api — 学习模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import type { ModuleContext } from "../context.js";
import { SqliteLearningRepository } from "@aervox/database";
import { registerLearningRoutes } from "./routes.js";
import { registerCap016017Routes } from "./cap016-017-routes.js";

export function registerLearningModule(ctx: ModuleContext): void {
  const { app, db } = ctx;
  const learningRepo = new SqliteLearningRepository(db);
  registerLearningRoutes(app, learningRepo);
  registerCap016017Routes(app, learningRepo);
}