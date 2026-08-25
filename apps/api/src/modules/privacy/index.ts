/**
 * Aervox｜思隅 @aervox/api — 隐私模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import type { FastifyInstance } from "fastify";
import { SqlitePrivacyRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import { registerPrivacyRoutes } from "./routes.js";

export function registerPrivacyModule(app: FastifyInstance, db: AervoxDatabase): void {
  const privacyRepo = new SqlitePrivacyRepository(db);
  registerPrivacyRoutes(app, privacyRepo);
}