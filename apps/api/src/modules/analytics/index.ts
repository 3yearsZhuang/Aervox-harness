/**
 * Aervox｜思隅 @aervox/api — 埋点模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import type { FastifyInstance } from "fastify";
import { SqliteAnalyticsRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import { registerAnalyticsRoutes } from "./routes.js";

export function registerAnalyticsModule(app: FastifyInstance, db: AervoxDatabase): void {
  const analyticsRepo = new SqliteAnalyticsRepository(db);
  registerAnalyticsRoutes(app, analyticsRepo);
}