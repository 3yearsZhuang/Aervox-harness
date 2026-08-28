/**
 * Aervox｜思隅 @aervox/api — CAP-020 插件运行时模块入口
 *
 * 组装：插件生命周期（工具/Skill 联动）+ 配置/Page（CR-006）。
 * 配置与 Page 使用新增路由文件（config-routes.ts），不改动既有 routes.ts（中间件重构期约束）。
 */
import path from "node:path";
import type { ModuleContext } from "../context.js";
import {
  SqliteExtensionRepository,
  SqlitePluginConfigRepository,
  SqlitePluginPageRepository,
  SqlitePluginSecretRepository,
  SqlitePlatformRepository,
  SqliteSkillRegistryRepository,
  SqliteToolRegistryRepository,
} from "@aervox/database";
import { registerPluginRoutes } from "./routes.js";
import { PluginService } from "./service.js";
import { PluginConfigService } from "./config-service.js";
import { registerPluginConfigRoutes } from "./config-routes.js";
import { PluginBundleStore } from "./bundle-store.js";
import { DEFAULT_SKILLS_ROOT } from "../skills/skill-manager.js";

const defaultPluginsRoot = (): string => {
  const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
  return path.join(repoRoot, "data", "plugins");
};

export function registerPluginsModule(ctx: ModuleContext): void {
  const { app, db, skillsRoot, pluginsRoot } = ctx;
  const extensionRepo = new SqliteExtensionRepository(db);
  const registry = new SqliteToolRegistryRepository(db);
  const skillRegistry = new SqliteSkillRegistryRepository(db);
  const resolvedSkillsRoot = skillsRoot ?? DEFAULT_SKILLS_ROOT;

  const configRepo = new SqlitePluginConfigRepository(db);
  const secretRepo = new SqlitePluginSecretRepository(db);
  const pageRepo = new SqlitePluginPageRepository(db);
  const auditRepo = new SqlitePlatformRepository(db);
  const bundleStore = new PluginBundleStore(pluginsRoot ?? defaultPluginsRoot());

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
    skillsRoot: resolvedSkillsRoot,
    cleanup: (pluginId) => configService.cleanupPlugin(pluginId),
  });

  registerPluginRoutes(app, service);
  registerPluginConfigRoutes(app, configService);
}
