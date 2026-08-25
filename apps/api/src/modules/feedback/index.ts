/**
 * Aervox｜思隅 @aervox/api — 反馈模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import type { FastifyInstance } from "fastify";
import { SqliteFeedbackRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import { registerFeedbackRoutes } from "./routes.js";

export function registerFeedbackModule(app: FastifyInstance, db: AervoxDatabase): void {
  const feedbackRepo = new SqliteFeedbackRepository(db);
  registerFeedbackRoutes(app, feedbackRepo);
}