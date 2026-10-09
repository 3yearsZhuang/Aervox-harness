/**
 * Aervox｜思隅 @aervox/api — 会话地图分支模块入口（P1 · CAP-014）
 */
import type { ModuleDependencies } from "../../context.js";
import { SqliteConversationRepository } from "@aervox/repositories";
import { registerBranchRoutes } from "./routes.js";

export function registerBranchModule(ctx: ModuleDependencies<"app" | "db">): void {
  const { app, db } = ctx;
  const repo = new SqliteConversationRepository(db);
  registerBranchRoutes(app, repo);
}