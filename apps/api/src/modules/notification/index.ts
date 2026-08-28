/**
 * Aervox｜思隅 @aervox/api — 通知模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import type { ModuleContext } from "../context.js";
import { SqlitePlatformRepository } from "@aervox/database";
import { registerNotificationRoutes } from "./routes.js";

export function registerNotificationModule(ctx: ModuleContext): void {
  const { app, db } = ctx;
  const platformRepo = new SqlitePlatformRepository(db);
  registerNotificationRoutes(app, platformRepo);
}