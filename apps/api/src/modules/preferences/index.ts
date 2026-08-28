/**
 * Aervox｜思隅 @aervox/api — 偏好模块入口（CAP-010 人格问卷与基础偏好）
 *
 * 自管仓储实例化。
 */
import type { ModuleContext } from "../context.js";
import { SqlitePersonaPreferencesRepository } from "@aervox/database";
import { registerPreferencesRoutes } from "./routes.js";

export function registerPreferencesModule(ctx: ModuleContext): void {
  const { app, db } = ctx;
  const repo = new SqlitePersonaPreferencesRepository(db);
  registerPreferencesRoutes(app, repo);
}