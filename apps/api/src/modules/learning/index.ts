/**
 * Aervox｜思隅 @aervox/api — 学习模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import type { FastifyInstance } from "fastify";
import { SqliteLearningRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import { registerLearningRoutes } from "./routes.js";

export function registerLearningModule(app: FastifyInstance, db: AervoxDatabase): void {
  const learningRepo = new SqliteLearningRepository(db);
  registerLearningRoutes(app, learningRepo);
}