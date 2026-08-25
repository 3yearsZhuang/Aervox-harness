/**
 * Aervox｜思隅 @aervox/api — 思维宇宙知识关系模块入口（P1 · CAP-015）
 */
import type { FastifyInstance } from "fastify";
import { SqliteLearningRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import { registerKnowledgeRoutes } from "./routes.js";

export function registerKnowledgeModule(app: FastifyInstance, db: AervoxDatabase): void {
  const repo = new SqliteLearningRepository(db);
  registerKnowledgeRoutes(app, repo);
}
