/**
 * Aervox｜思隅 @aervox/api — CAP-020 插件运行时模块入口
 *
 * 组装：插件生命周期（工具/Skill 联动）+ 配置/Page（CR-006）。
 * 配置与 Page 使用新增路由文件（config-routes.ts），不改动既有 routes.ts（中间件重构期约束）。
 */
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  SqliteExtensionRepository,
  SqlitePluginConfigRepository,
  SqlitePluginPageRepository,
  SqlitePluginSecretRepository,
  SqlitePlatformRepository,
  SqliteSkillRegistryRepository,
  SqliteToolRegistryRepository,
  type AervoxDatabase,
} from "@aervox/database";
import { registerPluginRoutes } from "./routes.js";
import { PluginService } from "./service.js";
import { PluginConfigService } from "./config-service.js";
import { registerPluginConfigRoutes } from "./config-routes.js";
import { PluginBundleStore } from "./bundle-store.js";
import { DEFAULT_SKILLS_ROOT } from "../skills/skill-manager.js";

export interface RegisterPluginsModuleOptions {
  /** 技能内容落盘根目录（插件技能写 <skillsRoot>/<pluginId>/；缺省 <repo>/data/skills） */
  skillsRoot?: string;
  /** 插件 Page Bundle 落盘根目录（缺省 <repo>/data/plugins） */
  pluginsRoot?: string;
}

const defaultPluginsRoot = (): string => {
  const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
  return path.join(repoRoot, "data", "plugins");
};

export function registerPluginsModule(
  app: FastifyInstance,
  db: AervoxDatabase,
  options: RegisterPluginsModuleOptions = {},
): void {
  const extensionRepo = new SqliteExtensionRepository(db);
  const registry = new SqliteToolRegistryRepository(db);
  const skillRegistry = new SqliteSkillRegistryRepository(db);
  const skillsRoot = options.skillsRoot ?? DEFAULT_SKILLS_ROOT;

  const configRepo = new SqlitePluginConfigRepository(db);
  const secretRepo = new SqlitePluginSecretRepository(db);
  const pageRepo = new SqlitePluginPageRepository(db);
  const auditRepo = new SqlitePlatformRepository(db);
  const bundleStore = new PluginBundleStore(options.pluginsRoot ?? defaultPluginsRoot());

  const configService = new PluginConfigService({
    extensionRepo,
    configRepo,
    secretRepo,
    pageRepo,
    auditRepo,
    bundleStore,
  });

  const service = new PluginService({
    extensionRepo,
    registry,
    skillRegistry,
    skillsRoot,
    cleanup: (pluginId) => configService.cleanupPlugin(pluginId),
  });

  registerPluginRoutes(app, service);
  registerPluginConfigRoutes(app, configService);
}
