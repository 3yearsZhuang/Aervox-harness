/**
 * Aervox｜思隅 @aervox/api — 思维宇宙知识关系模块入口（P1 · CAP-015）
 */
import type { ModuleContext } from "../context.js";
import { SqliteLearningRepository } from "@aervox/database";
import { registerKnowledgeRoutes } from "./routes.js";

export function registerKnowledgeModule(ctx: ModuleContext): void {
  const { app, db } = ctx;
  const repo = new SqliteLearningRepository(db);
  registerKnowledgeRoutes(app, repo);
}