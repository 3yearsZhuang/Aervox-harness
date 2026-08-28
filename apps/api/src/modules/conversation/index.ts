/**
 * Aervox｜思隅 @aervox/api — 对话模块入口
 *
 * 自管仓储实例化：本模块唯一对外入口，业务路由不依赖任何全局容器。
 * 阶段 2d：可注入 ToolRuntime 作为 Agent Loop 的只读工具提供者（缺失时 fail-closed）。
 */
import type { FastifyInstance } from "fastify";
import { SqliteConversationRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import type { ToolRuntime } from "../tools/runtime.js";
import { registerConversationRoutes } from "./routes.js";

export interface RegisterConversationModuleOptions {
  /** Agent Loop 只读工具提供者（阶段 2d，可选） */
  toolRuntime?: ToolRuntime;
}

export function registerConversationModule(
  app: FastifyInstance,
  db: AervoxDatabase,
  options: RegisterConversationModuleOptions = {},
): void {
  const conversationRepo = new SqliteConversationRepository(db);
  registerConversationRoutes(app, conversationRepo, { toolRuntime: options.toolRuntime });
}