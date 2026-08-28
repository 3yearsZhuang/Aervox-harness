/**
 * Aervox｜思隅 @aervox/api — 学习资料模块入口（CAP-011）
 */
import type { FastifyInstance } from "fastify";
import { SqliteStudyMaterialRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import { registerStudyMaterialRoutes } from "./routes.js";

export function registerStudyMaterialModule(app: FastifyInstance, db: AervoxDatabase): void {
  const repo = new SqliteStudyMaterialRepository(db);
  registerStudyMaterialRoutes(app, repo);
}