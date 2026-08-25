/**
 * Aervox｜思隅 @aervox/api — 记忆投影模块入口（P1）
 */
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";
import { SqliteMemoryRepository } from "@aervox/database";
import type { AervoxDatabase } from "@aervox/database";
import { registerMemoryRoutes } from "./routes.js";

export function registerMemoryModule(
  app: FastifyInstance,
  db: AervoxDatabase,
  client: Client,
): void {
  const repo = new SqliteMemoryRepository(db, client);
  registerMemoryRoutes(app, repo);
}
