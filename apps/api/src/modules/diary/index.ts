/**
 * Aervox｜思隅 @aervox/api — 日记模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import type { FastifyInstance } from "fastify";
import { SqliteDiaryRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import { registerDiaryRoutes } from "./routes.js";

export function registerDiaryModule(app: FastifyInstance, db: AervoxDatabase): void {
  const diaryRepo = new SqliteDiaryRepository(db);
  registerDiaryRoutes(app, diaryRepo);
}