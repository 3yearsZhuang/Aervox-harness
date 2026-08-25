/**
 * Aervox｜思隅 @aervox/api — 会话地图分支模块入口（P1 · CAP-014）
 */
import type { FastifyInstance } from "fastify";
import { SqliteConversationRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import { registerBranchRoutes } from "./routes.js";

export function registerBranchModule(app: FastifyInstance, db: AervoxDatabase): void {
  const repo = new SqliteConversationRepository(db);
  registerBranchRoutes(app, repo);
}
