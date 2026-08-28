/**
 * Aervox｜思隅 @aervox/api — 会话地图分支模块入口（P1 · CAP-014）
 */
import type { ModuleContext } from "../context.js";
import { SqliteConversationRepository } from "@aervox/database";
import { registerBranchRoutes } from "./routes.js";

export function registerBranchModule(ctx: ModuleContext): void {
  const { app, db } = ctx;
  const repo = new SqliteConversationRepository(db);
  registerBranchRoutes(app, repo);
}