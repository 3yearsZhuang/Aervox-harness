import { pluginSkillDirectoryName } from "@aervox/contracts";
/**
 * Aervox｜思隅 @aervox/api — CAP-020 插件运行时（生命周期 + 权限 + 工具/技能联动）
 *
 * 将 plugins 表（安装态/激活态）与 tool_registrations、skill_registrations 联动：
 * - 安装：createPlugin + 为该插件注册声明工具（pluginId 关联，非内置）
 *   + 写入声明的技能（source=plugin / readonly / pluginId 关联，内容落盘）；
 * - 启停：setPluginEnabled 联动其工具 enabled 与技能 active；
 * - 卸载：先注销插件工具与技能（readonly 也移除），再 deletePlugin
 *   （plugin_grants 级联清理）；
 * - 权限：grant/revoke/hasPluginPermission 复用既有仓储；门控求值默认实现
 *   与 tools 模块一致（defaultGatingEvaluator）。
 *
 * 规则依据：docs/reference/ARCHITECTURE.md §14.1 AST-04（安装态与激活态分离）
 * 与 Skill 能力（插件内置技能为只读指令包，生命周期归插件）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { comparePluginVersions, checkPluginHostCompatibility } from "@aervox/contracts";
import { RemotePluginRegistry } from "./remote-registry.js";
import { ApiError } from "../../../shared/errors.js";
import {
  SqliteExtensionRepository,
  SqliteSkillRegistryRepository,
  SqliteToolRegistryRepository,
  PLUGIN_IDENTITY_MIGRATIONS,
  type PluginModel,
  type SqlitePluginInstallationRepository,
  type PluginInstallation,
  type LocalContext,
} from "@aervox/repositories";
import { assertSkillDirectoryOwner, FileExistsError, withSkillMutation, isValidSkillName, parseFrontmatter } from "../skills/index.js";
import {
  type ServerPluginRegistry,
  defaultServerPluginRegistry,
} from "./turn-plugins/registry.js";
import {
  inspectPluginBundle,
  installPluginFromBundle,
  exportPluginBundle,
  listMarketPlugins,
  installFromMarket,
  type BundleEngineDeps,
} from "./package-bundle.js";
import type {
  PluginPackageInspection,
  PluginMarketItem,
  PluginMarketInstallRequest,
  PluginDeclaredTool,
  PluginDeclaredSkill,
} from "@aervox/contracts";
import type { PluginBundleStore } from "./bundle-store.js";
import type { PluginConfigService } from "./config-service.js";
import type {
  SqlitePluginConfigRepository,
  SqlitePluginPageRepository,
} from "@aervox/repositories";

export type { PluginDeclaredTool, PluginDeclaredSkill };

/**
 * CR-032：插件主动规则级联口。由 proactive 域提供 vault 实现（ProactiveRuleSyncPort
 * 的实现位于模块装配层），插件域不直接触碰加密 vault；未装配时级联静默跳过，
 * 由 Worker 物化器在下一周期兜底对齐。
 */
export interface ProactiveRuleSyncPort {
  /** 插件启停 → 物化规则批量启停 */
  setRulesEnabledByPlugin(pluginId: string, enabled: boolean): Promise<void>;
  /** 插件卸载 → 清除物化规则并撤销待处理主动动作 */
  purgePluginProactiveState(pluginId: string): Promise<void>;
}

export interface PluginServiceDeps {
  beforeDeactivate?: (pluginId: string, uninstall: boolean) => Promise<void>;
  installationRepo?: SqlitePluginInstallationRepository;
  extensionRepo: SqliteExtensionRepository;
  registry: SqliteToolRegistryRepository;
  skillRegistry: SqliteSkillRegistryRepository;
  /** 技能内容落盘根目录（插件技能写 <skillsRoot>/<pluginId>/<skillName>/） */
  skillsRoot: string;
  /** CR-006：卸载时清理插件配置/secret/Page 与 Bundle 目录 */
  cleanup?: (pluginId: string) => Promise<void>;
  /** CR-032：主动规则级联口（proactive vault 实现） */
  proactiveRuleSync?: ProactiveRuleSyncPort;
  /** 服务端插件注册表（别名索引与生命周期联动） */
  pluginRegistry?: ServerPluginRegistry;
  /** CAP-020 插件分发与打包引擎依赖 */
  configService?: PluginConfigService;
  bundleStore?: PluginBundleStore;
  configRepo?: SqlitePluginConfigRepository;
  pageRepo?: SqlitePluginPageRepository;
  builtinPluginsSourceRoot?: string;
  remoteRegistry?: RemotePluginRegistry;
}

export class PluginService {
  constructor(private readonly deps: PluginServiceDeps) {
    deps.bundleStore?.setGenerationResolver(async id => (await deps.extensionRepo.getPlugin(id))?.bundleGeneration ?? null);
  }

  activatePreparedBundle(input: PluginInstallation): Promise<PluginModel> {
    if (!this.deps.installationRepo) throw new Error("Atomic plugin installer is not configured");
    return this.deps.installationRepo.activate(input);
  }

  /** 注入分发引擎协作依赖 */
  setBundleDependencies(extra: {
    configService: PluginConfigService;
    bundleStore: PluginBundleStore;
    configRepo: SqlitePluginConfigRepository;
    pageRepo: SqlitePluginPageRepository;
    builtinPluginsSourceRoot?: string;
  }): void {
    Object.assign(this.deps, extra);
    extra.bundleStore.setGenerationResolver(async id => (await this.deps.extensionRepo.getPlugin(id))?.bundleGeneration ?? null);
  }

  private getBundleEngineDeps(): BundleEngineDeps {
    if (
      !this.deps.configService ||
      !this.deps.bundleStore ||
      !this.deps.configRepo ||
      !this.deps.pageRepo
    ) {
      throw new Error("Plugin bundle engine dependencies not fully initialized");
    }
    return {
      extensionRepo: this.deps.extensionRepo,
      configRepo: this.deps.configRepo,
      pageRepo: this.deps.pageRepo,
      registry: this.deps.registry,
      skillRegistry: this.deps.skillRegistry,
      skillsRoot: this.deps.skillsRoot,
      configService: this.deps.configService,
      bundleStore: this.deps.bundleStore,
      builtinPluginsSourceRoot: this.deps.builtinPluginsSourceRoot ?? "",
      service: this,
    };
  }

  /** 预检插件分发包（内存解包与静态结构分析，零副作用） */
  async inspectPackage(packageBase64: string, signal?: AbortSignal): Promise<PluginPackageInspection> {
    const bytes = new Uint8Array(Buffer.from(packageBase64, "base64"));
    return inspectPluginBundle(bytes, { extensionRepo: this.deps.extensionRepo }, signal);
  }

  /** 从分发包安装插件 */
  async installPackage(packageBase64: string, overwrite: boolean = false, signal?: AbortSignal): Promise<PluginModel> {
    const bytes = new Uint8Array(Buffer.from(packageBase64, "base64"));
    return installPluginFromBundle(bytes, { overwrite, signal }, this.getBundleEngineDeps());
  }

  /** 导出插件分发包 */
  async exportPackage(pluginId: string, signal?: AbortSignal): Promise<{ filename: string; packageBase64: string; checksum: string }> {
    const result = await exportPluginBundle(pluginId, this.getBundleEngineDeps(), signal);
    return {
      filename: result.filename,
      packageBase64: Buffer.from(result.bytes).toString("base64"),
      checksum: result.checksum,
    };
  }

  /** 获取官方与出厂插件集市条目 */
  async listMarketReport(): Promise<{ items: PluginMarketItem[]; registryError: string | null }> {
    try { return { items: await this.listMarket(), registryError: null }; }
    catch {
      const items = await listMarketPlugins({ extensionRepo: this.deps.extensionRepo,
        builtinPluginsSourceRoot: this.deps.builtinPluginsSourceRoot ?? "" });
      return { items, registryError: "在线插件索引暂不可用，当前显示出厂插件。" };
    }
  }

  async listMarket(): Promise<PluginMarketItem[]> {
    const local = await listMarketPlugins({
      extensionRepo: this.deps.extensionRepo,
      builtinPluginsSourceRoot: this.deps.builtinPluginsSourceRoot ?? "",
    });
    if (!this.deps.remoteRegistry) return local;
    const catalog = await this.deps.remoteRegistry.catalog();
    const installed = new Map((await this.deps.extensionRepo.listPlugins()).map(plugin => [plugin.id, plugin]));
    const items = new Map(local.map(item => [item.id, item]));
    for (const entry of catalog.plugins) {
      if (!checkPluginHostCompatibility(entry).compatible) continue;
      const previous = installed.get(entry.id);
      const builtin = items.get(entry.id);
      // A remote catalog never downgrades a newer bundled or installed release.
      const bundledComparison = builtin ? comparePluginVersions(entry.latestVersion, builtin.version) : null;
      if (bundledComparison !== null && bundledComparison < 0) continue;
      const comparison = previous ? comparePluginVersions(entry.latestVersion, previous.version) : null;
      if (previous && comparison !== 0 && comparison !== 1) continue;
      items.set(entry.id, { id: entry.id, displayName: entry.displayName, publisher: entry.publisher,
        version: entry.latestVersion, description: entry.description, license: entry.license ?? "",
        source: "market", category: entry.category, tags: entry.tags, breaking: entry.breaking,
        downloadUrl: entry.downloadUrl, sha256: entry.sha256, size: entry.size,
        installed: Boolean(previous), installedVersion: previous?.version ?? null,
        hasUpdate: comparison !== null && comparison > 0,
        capabilities: entry.capabilities ?? builtin?.capabilities ?? { hasConfig: false, sensorsCount: 0, triggersCount: 0, toolsCount: 0, skillsCount: 0, pagesCount: 0 } });
    }
    return [...items.values()];
  }

  /** 从出厂集市一键安装插件 */
  async installFromMarket(pluginId: string, signal?: AbortSignal, options: PluginMarketInstallRequest = {}): Promise<PluginModel> {
    if (this.deps.remoteRegistry) {
      const catalog = await this.deps.remoteRegistry.catalog(signal).catch(error => {
        if (options.expectedSha256 || signal?.aborted) throw error;
        return { plugins: [] };
      });
      if (catalog.plugins.some(item => item.id === pluginId)) {
        const { entry, bytes } = await this.deps.remoteRegistry.download(pluginId, signal);
        if (options.expectedVersion !== entry.latestVersion || options.expectedSha256 !== entry.sha256) {
          throw new ApiError("CONFLICT", 409, "Plugin release changed or was not selected; refresh the market before installing");
        }
        const installed = await this.deps.extensionRepo.getPlugin(pluginId);
        const builtin = (await listMarketPlugins({ extensionRepo: this.deps.extensionRepo,
          builtinPluginsSourceRoot: this.deps.builtinPluginsSourceRoot ?? "" })).find(item => item.id === pluginId);
        if (builtin && comparePluginVersions(entry.latestVersion, builtin.version) !== 0
          && comparePluginVersions(entry.latestVersion, builtin.version) !== 1) throw new Error("Registry downgrade refused");
        if (installed && comparePluginVersions(entry.latestVersion, installed.version) !== 0
          && comparePluginVersions(entry.latestVersion, installed.version) !== 1) throw new Error("Registry downgrade or incomparable version refused");
        if (installed?.bundleGeneration && installed.version === entry.latestVersion && installed.checksum.replace(/^sha256:/, "") !== entry.sha256) {
          throw new Error("Published plugin release changed its checksum");
        }
        if (installed && installed.version !== entry.latestVersion && entry.breaking && !options.allowBreaking) {
          throw new ApiError("CONFLICT", 409, "Breaking plugin update requires explicit confirmation");
        }
        return installPluginFromBundle(bytes, { overwrite: true, signal }, this.getBundleEngineDeps());
      }
    }
    if (options.expectedVersion) {
      const selected = (await listMarketPlugins({ extensionRepo: this.deps.extensionRepo,
        builtinPluginsSourceRoot: this.deps.builtinPluginsSourceRoot ?? "" })).find(item => item.id === pluginId);
      if (selected?.version !== options.expectedVersion || options.expectedSha256) {
        throw new ApiError("CONFLICT", 409, "Plugin source changed; refresh the market before installing");
      }
    }
    return installFromMarket(pluginId, this.getBundleEngineDeps(), signal);
  }

  /** 列出全部插件 */
  listPlugins(): Promise<PluginModel[]> {
    return this.deps.extensionRepo.listPlugins();
  }

  /** 安装：登记插件 + 同步声明工具与技能（幂等）；proactiveSpec 须已经清单 zod fail-closed 校验 */
  async installPlugin(plugin: {
    id: string;
    publisher: string;
    version: string;
    checksum?: string;
    signature?: string | null;
    permissions?: unknown;
    installSource?: string;
    tools?: PluginDeclaredTool[];
    skills?: PluginDeclaredSkill[];
    /** CR-032：主动智能声明（pluginProactiveSpecSchema 校验后的结果） */
    proactiveSpec?: unknown;
  }): Promise<PluginModel> {
    return withSkillMutation(this.deps.skillsRoot, async () => {
      if ((await this.deps.extensionRepo.getPlugin(plugin.id))?.bundleGeneration) {
        throw new ApiError("PLUGIN_PACKAGE_IMMUTABLE", 409, "Repackage and install a new version to replace a packaged plugin");
      }
      await this.checkSkillOwnership(plugin.id, plugin.skills ?? []);
      const created = await this.deps.extensionRepo.createPlugin({
        id: plugin.id,
        publisher: plugin.publisher,
        version: plugin.version,
        checksum: plugin.checksum ?? `sha256:${plugin.id}:${plugin.version}`,
        signature: plugin.signature ?? null,
        permissions: plugin.permissions ?? [],
        installSource: plugin.installSource ?? "registry",
        // 显式 null 清空旧声明：重装未声明 proactive 的插件不得残留历史声明
        proactiveSpecJson: plugin.proactiveSpec ?? null,
      });

      for (const tool of plugin.tools ?? []) {
        const baseId = tool.id ?? tool.name;
        const toolId = baseId.startsWith(`${plugin.id}.`)
          ? baseId
          : `${plugin.id}.${baseId}`;
        await this.deps.registry.registerTool({
          id: toolId,
          name: tool.name,
          description: tool.description ?? "",
          category: tool.category ?? "plugin",
          safetyLevel: tool.safetyLevel,
          requiredPermissions: tool.requiredPermissions,
          inputSchema: tool.inputSchema,
          builtin: false,
          pluginId: plugin.id,
          gatingConditions: tool.gatingConditions,
          priority: tool.priority ?? 0,
        });
      }

      // 声明技能：写入本地 + 只读注册（生命周期归插件，启停联动）
      for (const skill of plugin.skills ?? []) {
        if (!isValidSkillName(skill.name)) continue;
        const content = skill.content ?? "";
        const frontmatter = parseFrontmatter(content);
        const skillDir = path.join(this.deps.skillsRoot, plugin.id, pluginSkillDirectoryName(skill.name));
        await fs.mkdir(skillDir, { recursive: true });
        await fs.writeFile(path.join(skillDir, "SKILL.md"), content, "utf8");
        await this.deps.skillRegistry.registerSkill({
          id: skill.name,
          name: skill.name,
          description: skill.description || frontmatter.description || `Plugin skill: ${skill.name}`,
          source: "plugin",
          active: true,
          readonly: true,
          pluginId: plugin.id,
          contentPath: path.join(skillDir, "SKILL.md"),
        });
      }

      return created;
    });
  }

  /** Preflight the full declaration before creating plugin/tool rows or removing an old version. */
  async checkSkillOwnership(id: string, skills: PluginDeclaredSkill[], writesLegacyDirectory = true): Promise<void> {
    if (Object.hasOwn(PLUGIN_IDENTITY_MIGRATIONS, id)) {
      throw new ApiError("CONFLICT", 409, "Legacy first-party plugin identity is retired; use the current package or migrate existing data offline");
    }
    if (!isValidSkillName(id) || id.includes(":")) throw new FileExistsError("Invalid plugin directory name.");
    if (writesLegacyDirectory && skills.length) await assertSkillDirectoryOwner(this.deps.skillRegistry, this.deps.skillsRoot, { kind: "plugin", id });
    const names = new Set<string>();
    for (const skill of skills) {
      if (!isValidSkillName(skill.name) || names.has(skill.name)
        || (skill.name.includes(":") && !skill.name.startsWith(`${id}:`))) throw new FileExistsError("Invalid or duplicate plugin skill name.");
      names.add(skill.name);
      const existing = await this.deps.skillRegistry.getSkill(skill.name);
      if (existing && existing.pluginId !== id) throw new FileExistsError(`Skill ${skill.name} belongs to another owner.`);
    }
  }

  /** 启停插件 + 联动其工具 enabled 与技能 active */
  async setEnabled(id: string, enabled: boolean): Promise<PluginModel | null> {
    if (!enabled) await this.deps.beforeDeactivate?.(id, false);
    let targetId = id;
    let updated = await this.deps.extensionRepo.setPluginEnabled(targetId, enabled);
    const registry = this.deps.pluginRegistry ?? defaultServerPluginRegistry;
    if (!updated) {
      const candidateIds = registry.getAllAliases(id);
      for (const cid of candidateIds) {
        if (cid === id) continue;
        updated = await this.deps.extensionRepo.setPluginEnabled(cid, enabled);
        if (updated) {
          targetId = cid;
          break;
        }
      }
    }
    if (!updated) return null;
    const allKnownAliases = registry.getAllAliases(targetId);
    const pluginIds = Array.from(new Set([targetId, id, ...allKnownAliases]));
    await this.deps.registry.setToolsEnabledByPlugin(pluginIds, enabled);
    await this.deps.skillRegistry.setSkillsActiveByPlugin(pluginIds, enabled);
    // CR-032：级联启停该插件的物化主动规则（未装配 Port 时由 Worker 物化器兜底）
    for (const pluginId of pluginIds) {
      await this.deps.proactiveRuleSync?.setRulesEnabledByPlugin(pluginId, enabled).catch(() => undefined);
    }
    return updated;
  }

  /** 卸载：先注销插件工具与技能（含 readonly），再删插件（grants 级联清理） */
  async uninstallPlugin(id: string): Promise<boolean> {
    if (!isValidSkillName(id)) return false;
    return withSkillMutation(this.deps.skillsRoot, async () => {
      if (!await this.deps.extensionRepo.getPlugin(id)) return false;
      await this.deps.beforeDeactivate?.(id, true);
      const legacyRoot = path.resolve(this.deps.skillsRoot, id);
      const owned = (await this.deps.skillRegistry.listSkills()).some(skill => skill.pluginId === id
        && (!skill.contentPath || path.resolve(skill.contentPath).startsWith(legacyRoot + path.sep)));
      if (owned) {
        await assertSkillDirectoryOwner(this.deps.skillRegistry, this.deps.skillsRoot, { kind: "plugin", id });
        await fs.rm(path.join(this.deps.skillsRoot, id), { recursive: true, force: true });
      }
      await this.deps.registry.unregisterToolsByPlugin(id);
      await this.deps.skillRegistry.removeSkillsByPlugin(id);
      if (this.deps.cleanup) await this.deps.cleanup(id);
      await this.deps.proactiveRuleSync?.purgePluginProactiveState(id).catch(() => undefined);
      return this.deps.extensionRepo.deletePlugin(id);
    });
  }

  /** 授予插件权限 */
  grant(
    tenant: LocalContext,
    grant: { id: string; pluginId: string; permission: string; scope: string },
  ) {
    return this.deps.extensionRepo.grantPlugin(tenant, grant);
  }

  /** 撤销插件权限 */
  async revoke(tenant: LocalContext, id: string, expectedPluginId?: string) {
    const grant = await this.deps.extensionRepo.revokePluginGrant(tenant, id, expectedPluginId);
    if (grant) await this.deps.beforeDeactivate?.(grant.pluginId, false);
    return grant;
  }

  /** 查询插件是否具备指定权限 */
  hasPermission(tenant: LocalContext, pluginId: string, permission: string) {
    return this.deps.extensionRepo.hasPluginPermission(tenant, pluginId, permission);
  }

  /** CR-032：查询插件是否具备指定 scope 的授权（感知源授权） */
  hasGrant(tenant: LocalContext, pluginId: string, permission: string, scope: string) {
    return this.deps.extensionRepo.hasPluginGrant(tenant, pluginId, permission, scope);
  }

  /** CR-032：列出插件的全部有效感知源授权（撤销需 grantId） */
  listSensorGrants(tenant: LocalContext, pluginId: string, permission: string) {
    return this.deps.extensionRepo.listActiveGrantsByPermission(tenant, permission)
      .then((grants) => grants.filter((grant) => grant.pluginId === pluginId));
  }
}
