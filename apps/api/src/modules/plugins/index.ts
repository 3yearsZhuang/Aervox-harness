/**
 * Aervox｜思隅 @aervox/api — CAP-020 插件运行时模块入口
 */
import type { FastifyInstance } from "fastify";
import {
  SqliteExtensionRepository,
  SqliteSkillRegistryRepository,
  SqliteToolRegistryRepository,
  type AervoxDatabase,
} from "@aervox/database";
import { registerPluginRoutes } from "./routes.js";
import { PluginService } from "./service.js";
import { DEFAULT_SKILLS_ROOT } from "../skills/skill-manager.js";

export interface RegisterPluginsModuleOptions {
  /** 技能内容落盘根目录（插件技能写 <skillsRoot>/<pluginId>/；缺省 <repo>/data/skills） */
  skillsRoot?: string;
}

export function registerPluginsModule(
  app: FastifyInstance,
  db: AervoxDatabase,
  options: RegisterPluginsModuleOptions = {},
): void {
  const extensionRepo = new SqliteExtensionRepository(db);
  const registry = new SqliteToolRegistryRepository(db);
  const skillRegistry = new SqliteSkillRegistryRepository(db);
  const service = new PluginService({
    extensionRepo,
    registry,
    skillRegistry,
    skillsRoot: options.skillsRoot ?? DEFAULT_SKILLS_ROOT,
  });
  registerPluginRoutes(app, service);
}