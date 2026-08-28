/**
 * Aervox｜思隅 @aervox/api — 受控收件箱（Agent Inbox）模块入口（阶段 5a-2）
 *
 * 自管仓储实例化：SqliteAgentInboxRepository（enqueue 面）+ SqliteExtensionRepository
 * （插件 x-plugin-id 身份校验）。规则依据 §7.2 + ADR-017。
 */
import type { ModuleContext } from "../context.js";
import { SqliteAgentInboxRepository, SqliteExtensionRepository } from "@aervox/database";
import { registerInboxRoutes } from "./routes.js";

export function registerInboxModule(ctx: ModuleContext): void {
  const { app, db } = ctx;
  const inboxRepo = new SqliteAgentInboxRepository(db);
  const extensionRepo = new SqliteExtensionRepository(db);
  registerInboxRoutes(app, { inboxRepo, extensionRepo });
}