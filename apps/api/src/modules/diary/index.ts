/**
 * Aervox｜思隅 @aervox/api — 日记模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import type { ModuleContext } from "../context.js";
import { SqliteDiaryRepository } from "@aervox/database";
import { registerDiaryRoutes } from "./routes.js";

export function registerDiaryModule(ctx: ModuleContext): void {
  const { app, db } = ctx;
  const diaryRepo = new SqliteDiaryRepository(db);
  registerDiaryRoutes(app, diaryRepo);
}