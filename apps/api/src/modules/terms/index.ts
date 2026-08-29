/**
 * Aervox｜思隅 @aervox/api — 术语抽取与概念探索模块入口（CAP-007 / CAP-002）
 *
 * 符合 ADR-014 演进式模块化单体与 AVX-PLUG-001 插件规范。
 */
import type { ModuleContext } from "../context.js";
import { SqliteConversationRepository } from "@aervox/database";
import { registerTermsRoutes } from "./routes.js";

export function registerTermsModule(ctx: ModuleContext): void {
  const { app, db } = ctx;
  const conversationRepo = new SqliteConversationRepository(db);
  registerTermsRoutes(app, conversationRepo);
}

export { registerTermsRoutes } from "./routes.js";
