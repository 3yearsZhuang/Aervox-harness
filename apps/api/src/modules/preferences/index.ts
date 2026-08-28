/**
 * Aervox｜思隅 @aervox/api — 偏好模块入口（CAP-010 人格问卷与基础偏好）
 *
 * 自管仓储实例化。
 */
import type { FastifyInstance } from "fastify";
import { SqlitePersonaPreferencesRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import { registerPreferencesRoutes } from "./routes.js";

export function registerPreferencesModule(app: FastifyInstance, db: AervoxDatabase): void {
  const repo = new SqlitePersonaPreferencesRepository(db);
  registerPreferencesRoutes(app, repo);
}