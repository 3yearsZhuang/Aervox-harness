/**
 * Aervox｜思隅 @aervox/api — 通知模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import type { FastifyInstance } from "fastify";
import { SqlitePlatformRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import { registerNotificationRoutes } from "./routes.js";

export function registerNotificationModule(app: FastifyInstance, db: AervoxDatabase): void {
  const platformRepo = new SqlitePlatformRepository(db);
  registerNotificationRoutes(app, platformRepo);
}