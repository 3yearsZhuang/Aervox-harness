/**
 * Aervox｜思隅 @aervox/api — 记忆投影模块入口（P1）
 */
import type { ModuleContext } from "../context.js";
import { SqliteMemoryRepository } from "@aervox/database";
import { registerMemoryRoutes } from "./routes.js";

export function registerMemoryModule(ctx: ModuleContext): void {
  const { app, db, client } = ctx;
  const repo = new SqliteMemoryRepository(db, client);
  registerMemoryRoutes(app, repo);
}