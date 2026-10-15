/**
 * Aervox｜思隅 @aervox/api — 项目管理与外部导入模块入口（CR-048 / W3）
 */
import type { ModuleDependencies } from "../../context.js";
import {
  SqliteProjectRepository,
  SqliteConversationRepository,
} from "@aervox/repositories";
import { registerProjectRoutes } from "./routes.js";

export function registerProjectModule(ctx: ModuleDependencies<"app" | "db">): void {
  const { app, db } = ctx;
  const projectRepo = new SqliteProjectRepository(db);
  const conversationRepo = new SqliteConversationRepository(db);
  registerProjectRoutes(app, projectRepo, conversationRepo);
}
