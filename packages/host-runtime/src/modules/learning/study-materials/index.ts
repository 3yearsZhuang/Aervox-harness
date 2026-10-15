/**
 * Aervox｜思隅 @aervox/api — 学习资料模块入口（CAP-011）
 */
import type { ModuleDependencies } from "../../context.js";
import { SqliteStudyMaterialRepository } from "@aervox/repositories";
import { registerStudyMaterialRoutes } from "./routes.js";

export function registerStudyMaterialModule(ctx: ModuleDependencies<"app" | "db">): void {
  const { app, db } = ctx;
  const repo = new SqliteStudyMaterialRepository(db);
  registerStudyMaterialRoutes(app, repo);
}