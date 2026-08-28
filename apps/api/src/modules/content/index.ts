/**
 * Aervox｜思隅 @aervox/api — 内容模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import type { ModuleContext } from "../context.js";
import { SqliteContentRepository } from "@aervox/database";
import { registerContentRoutes } from "./routes.js";

export function registerContentModule(ctx: ModuleContext): void {
  const { app, db } = ctx;
  const contentRepo = new SqliteContentRepository(db);
  registerContentRoutes(app, contentRepo);
}