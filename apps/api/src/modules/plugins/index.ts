/**
 * Aervox｜思隅 @aervox/api — CAP-020 插件运行时模块入口
 *
 * 组装：插件生命周期（工具/Skill 联动）+ 配置/Page（CR-006）。
 * 配置与 Page 使用新增路由文件（config-routes.ts），不改动既有 routes.ts（中间件重构期约束）。
 */
import fs from "node:fs/promises";
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

const defaultBuiltinPluginsSourceRoot = (): string => {
  const repoRoot = path.resolve(import.meta.dirname, "../../../../..");
  return path.join(repoRoot, "plugins");
};

/**
 * 启动时自动同步并注册内置插件目录（plugins/*），实现自发现与预装。
 */
async function syncBuiltinPlugins(
  sourceRoot: string,
  service: PluginService,
  configService: PluginConfigService,
): Promise<void> {
  try {
    const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(sourceRoot, entry.name);
      const manifestPath = path.join(pluginDir, "plugin.manifest.json");
      const schemaPath = path.join(pluginDir, "config.schema.json");
      const skillPath = path.join(pluginDir, "SKILL.md");

      let manifestRaw: string;
      try {
        manifestRaw = await fs.readFile(manifestPath, "utf8");
      } catch {
        continue; // 非插件 Bundle 目录跳过
      }

      let manifest: {
        metadata?: { id?: string; publisher?: string; version?: string; description?: string };
      };
      try {
        manifest = JSON.parse(manifestRaw);
      } catch {
        continue;
      }

      if (!manifest.metadata?.id || !manifest.metadata?.publisher || !manifest.metadata?.version) {
        continue;
      }

      let skillContent = "";
      try {
        skillContent = await fs.readFile(skillPath, "utf8");
      } catch {
        // 可选无独立 SKILL.md
      }

      // 1. 安装 / 同步插件
      await service.installPlugin({
        id: manifest.metadata.id,
        publisher: manifest.metadata.publisher,
        version: manifest.metadata.version,
        installSource: "builtin",
        skills: skillContent
          ? [
              {
                name: entry.name,
                description: manifest.metadata.description,
                content: skillContent,
              },
            ]
          : [],
      });

      // 2. 注册 Schema（若存在）
      try {
        const schemaRaw = await fs.readFile(schemaPath, "utf8");
        const schema = JSON.parse(schemaRaw);
        await configService.registerConfigSchema(manifest.metadata.id, schema);
      } catch {
        // 忽略无 Schema 或非法 Schema
      }
    }
  } catch {
    // 目录不存在或不可读时降级静默
  }
}

export async function registerPluginsModule(ctx: ModuleContext): Promise<void> {
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

  // 同步内置插件目录（plugins/）
  const builtinRoot = defaultBuiltinPluginsSourceRoot();
  await syncBuiltinPlugins(builtinRoot, service, configService);
}
