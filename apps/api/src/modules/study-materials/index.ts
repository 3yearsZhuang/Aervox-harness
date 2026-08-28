/**
 * Aervox｜思隅 @aervox/api — 学习资料模块入口（CAP-011）
 */
import type { ModuleContext } from "../context.js";
import { SqliteStudyMaterialRepository } from "@aervox/database";
import { registerStudyMaterialRoutes } from "./routes.js";

export function registerStudyMaterialModule(ctx: ModuleContext): void {
  const { app, db } = ctx;
  const repo = new SqliteStudyMaterialRepository(db);
  registerStudyMaterialRoutes(app, repo);
}