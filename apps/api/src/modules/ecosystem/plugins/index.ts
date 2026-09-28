/**
 * Aervox｜思隅 @aervox/api — CAP-020 插件运行时模块入口
 *
 * 组装：插件生命周期（工具/Skill 联动）+ 配置/Page（CR-006）。
 * 配置与 Page 使用新增路由文件（config-routes.ts），不改动既有 routes.ts（中间件重构期约束）。
 */
import { focusModeTurnPlugin } from "./turn-plugins/focus-mode.js";
import fs from "node:fs/promises";
import path from "node:path";
import { pluginManifestSchema } from "@aervox/contracts";
import type { ModuleContext } from "../../context.js";
import {
  SqliteExtensionRepository,
  SqlitePluginConfigRepository,
  SqlitePluginPageRepository,
  SqlitePluginSecretRepository,
  SqlitePlatformRepository,
  SqliteSkillRegistryRepository,
  SqliteToolRegistryRepository,
} from "@aervox/repositories";
import { registerPluginRoutes } from "./routes.js";
import { PluginService } from "./service.js";
import { PluginConfigService } from "./config-service.js";
import { registerPluginConfigRoutes } from "./config-routes.js";
import { PluginBundleStore } from "./bundle-store.js";
import { DEFAULT_SKILLS_ROOT } from "../skills/skill-manager.js";
import {
  defaultServerPluginRegistry,
  defaultServerTurnPluginRegistry,
  ServerPluginRegistry,
  ServerTurnPluginRegistry,
} from "./turn-plugins/registry.js";
export * from "./turn-plugins/index.js";
export {
  defaultServerPluginRegistry,
  defaultServerTurnPluginRegistry,
  ServerPluginRegistry,
  ServerTurnPluginRegistry,
};

export function createServerPluginRegistry(): ServerPluginRegistry {
  const registry = new ServerPluginRegistry();
  registry.register(focusModeTurnPlugin);
  return registry;
}

const defaultPluginsRoot = (): string => {
  const repoRoot = path.resolve(import.meta.dirname, "../../../../../..");
  return path.join(repoRoot, "data", "plugins");
};

const defaultBuiltinPluginsSourceRoot = (): string => {
  const repoRoot = path.resolve(import.meta.dirname, "../../../../../..");
  return path.join(repoRoot, "plugins");
};

/**
 * 启动时自动同步并注册内置插件目录（plugins/*），实现自发现与预装。
 */
async function syncBuiltinPlugins(
  sourceRoot: string,
  service: PluginService,
  configService: PluginConfigService,
  extensionRepo: SqliteExtensionRepository,
): Promise<void> {
  const diskPluginIds = new Set<string>();
  let failure: "missing" | "invalid" | "unreadable" = "missing";
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

      // CR-032：内置插件清单统一走 zod fail-closed 校验，非法清单（含非法主动声明）整包拒装
      let manifestValue: unknown;
      try { manifestValue = JSON.parse(manifestRaw); } catch { failure = "invalid"; continue; }
      const parsedManifest = pluginManifestSchema.safeParse(manifestValue);
      if (!parsedManifest.success) {
        failure = "invalid";
        console.warn(`[plugins] builtin manifest rejected (fail-closed): ${entry.name}`);
        continue;
      }
      const manifest = parsedManifest.data;
      const pluginId = manifest.metadata.id;


      let skillContent = "";
      try {
        skillContent = await fs.readFile(skillPath, "utf8");
      } catch {
        // 可选无独立 SKILL.md
      }

      // 1. 安装 / 同步插件
      await service.installPlugin({
        id: pluginId,
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
        proactiveSpec: manifest.spec.proactive,
      });

      // 2. 注册 Schema（若存在）
      try {
        const schemaRaw = await fs.readFile(schemaPath, "utf8");
        const schema = JSON.parse(schemaRaw);
        await configService.registerConfigSchema(pluginId, schema);
      } catch {
        // 忽略无 Schema 或非法 Schema
      }
      diskPluginIds.add(pluginId);
    }

  } catch (error) {
    failure = "unreadable";
    console.warn("[plugins] builtin source unavailable; installation data retained", error);
  }
  for (const plugin of await service.listPlugins()) {
    if (plugin.installSource === "builtin") {
      await extensionRepo.setPluginAvailability(plugin.id, diskPluginIds.has(plugin.id) ? "available" : failure);
    }
  }
}

export async function registerPluginsModule(ctx: ModuleContext): Promise<void> {
  ctx.pluginRegistry ??= createServerPluginRegistry();
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
    pluginRegistry: ctx.pluginRegistry,
  });

  // CR-032：proactive 模块先于本模块注册并填充 ctx.proactiveIntelligenceRepository，
  // 据此构建插件 → vault 物化规则的级联口（未装配时为 undefined，Worker 物化器兜底）。
  const intelligenceRepo = ctx.proactiveIntelligenceRepository;
  const localTenant = {workspaceId: "local", subjectUserId: "local"} as const;
  const proactiveRuleSync = intelligenceRepo
    ? {
        async setRulesEnabledByPlugin(pluginId: string, enabled: boolean): Promise<void> {
          await intelligenceRepo.setTriggerRulesEnabledByPlugin(localTenant, pluginId, enabled);
        },
        async purgePluginProactiveState(pluginId: string): Promise<void> {
          // 规则即刻拔除；待办动作由 Worker 调度时重验规则存在性而失效，账本留痕
          await intelligenceRepo.deleteTriggerRulesByPlugin(localTenant, pluginId);
        },
      }
    : undefined;

  const builtinRoot = ctx.builtinPluginsSourceRoot ?? defaultBuiltinPluginsSourceRoot();

  const service = new PluginService({
    extensionRepo,
    registry,
    skillRegistry,
    skillsRoot: resolvedSkillsRoot,
    cleanup: (pluginId) => configService.cleanupPlugin(pluginId),
    proactiveRuleSync,
    pluginRegistry: ctx.pluginRegistry,
    configService,
    bundleStore,
    configRepo,
    pageRepo,
    builtinPluginsSourceRoot: builtinRoot,
  });

  registerPluginRoutes(app, service);
  registerPluginConfigRoutes(app, configService);

  // 同步内置插件目录（plugins/）
  await syncBuiltinPlugins(builtinRoot, service, configService, extensionRepo);
}

export * from "./turn-plugins/index.js";
