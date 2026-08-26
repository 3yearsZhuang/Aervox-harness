/**
 * Aervox｜思隅 @aervox/api — CAP-020 插件运行时模块入口
 */
import type { FastifyInstance } from "fastify";
import {
  SqliteExtensionRepository,
  SqliteToolRegistryRepository,
  type AervoxDatabase,
} from "@aervox/database";
import { registerPluginRoutes } from "./routes.js";
import { PluginService } from "./service.js";

export function registerPluginsModule(app: FastifyInstance, db: AervoxDatabase): void {
  const extensionRepo = new SqliteExtensionRepository(db);
  const registry = new SqliteToolRegistryRepository(db);
  const service = new PluginService({ extensionRepo, registry });
  registerPluginRoutes(app, service);
}