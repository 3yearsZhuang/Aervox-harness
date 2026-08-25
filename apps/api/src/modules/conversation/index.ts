/**
 * Aervox｜思隅 @aervox/api — 对话模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 */
import type { FastifyInstance } from "fastify";
import { SqliteConversationRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import { registerConversationRoutes } from "./routes.js";

export function registerConversationModule(app: FastifyInstance, db: AervoxDatabase): void {
  const conversationRepo = new SqliteConversationRepository(db);
  registerConversationRoutes(app, conversationRepo);
}