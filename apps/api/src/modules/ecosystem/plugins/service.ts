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
 * 规则依据：docs/explanation/reference-design-transfer.md §4.7 AST-04（安装态与激活态分离）
 * 与 Skill 能力（插件内置技能为只读指令包，生命周期归插件）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  SqliteExtensionRepository,
  SqliteSkillRegistryRepository,
  SqliteToolRegistryRepository,
  type PluginModel,
  type LocalContext,
} from "@aervox/repositories";
import { isValidSkillName, parseFrontmatter } from "../skills/skill-manager.js";
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
} from "@aervox/contracts";
import type { PluginBundleStore } from "./bundle-store.js";
import type { PluginConfigService } from "./config-service.js";
import type {
  SqlitePluginConfigRepository,
  SqlitePluginPageRepository,
} from "@aervox/repositories";

/** 插件声明的工具（安装时注册进 tool_registrations） */
export interface PluginDeclaredTool {
  /** 工具标识；缺省以 name 作为 id 基底 */
  id?: string;
  name: string;
  description?: string;
  category?: string;
  safetyLevel?: string;
  requiredPermissions?: unknown;
  inputSchema?: unknown;
  gatingConditions?: unknown;
  priority?: number;
}

/** 插件声明的技能（安装时写入本地并只读注册进 skill_registrations） */
export interface PluginDeclaredSkill {
  /** 技能名（须匹配 ^[\w.-]+$） */
  name: string;
  /** 简短描述；缺省从 SKILL.md frontmatter 解析 */
  description?: string;
  /** SKILL.md 全文 */
  content?: string;
}

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
}

export class PluginService {
  constructor(private readonly deps: PluginServiceDeps) {}

  /** 注入分发引擎协作依赖 */
  setBundleDependencies(extra: {
    configService: PluginConfigService;
    bundleStore: PluginBundleStore;
    configRepo: SqlitePluginConfigRepository;
    pageRepo: SqlitePluginPageRepository;
    builtinPluginsSourceRoot?: string;
  }): void {
    Object.assign(this.deps, extra);
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
  async inspectPackage(packageBase64: string): Promise<PluginPackageInspection> {
    const bytes = new Uint8Array(Buffer.from(packageBase64, "base64"));
    return inspectPluginBundle(bytes, { extensionRepo: this.deps.extensionRepo });
  }

  /** 从分发包安装插件 */
  async installPackage(packageBase64: string, overwrite: boolean = false): Promise<PluginModel> {
    const bytes = new Uint8Array(Buffer.from(packageBase64, "base64"));
    return installPluginFromBundle(bytes, { overwrite }, this.getBundleEngineDeps());
  }

  /** 导出插件分发包 */
  async exportPackage(pluginId: string): Promise<{ filename: string; packageBase64: string; checksum: string }> {
    const result = await exportPluginBundle(pluginId, this.getBundleEngineDeps());
    return {
      filename: result.filename,
      packageBase64: Buffer.from(result.bytes).toString("base64"),
      checksum: result.checksum,
    };
  }

  /** 获取官方与出厂插件集市条目 */
  async listMarket(): Promise<PluginMarketItem[]> {
    return listMarketPlugins({
      extensionRepo: this.deps.extensionRepo,
      builtinPluginsSourceRoot: this.deps.builtinPluginsSourceRoot ?? "",
    });
  }

  /** 从出厂集市一键安装插件 */
  async installFromMarket(pluginId: string): Promise<PluginModel> {
    return installFromMarket(pluginId, this.getBundleEngineDeps());
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
      const skillDir = path.join(this.deps.skillsRoot, plugin.id, skill.name);
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
  }

  /** 启停插件 + 联动其工具 enabled 与技能 active */
  async setEnabled(id: string, enabled: boolean): Promise<PluginModel | null> {
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
    await this.deps.registry.unregisterToolsByPlugin(id);
    await this.deps.skillRegistry.removeSkillsByPlugin(id);
    await fs.rm(path.join(this.deps.skillsRoot, id), { recursive: true, force: true }).catch(() => undefined);
    if (this.deps.cleanup) await this.deps.cleanup(id);
    // CR-032：先清除物化规则与待办动作，再删除插件行（杜绝幽灵规则）
    await this.deps.proactiveRuleSync?.purgePluginProactiveState(id).catch(() => undefined);
    return this.deps.extensionRepo.deletePlugin(id);
  }

  /** 授予插件权限 */
  grant(
    tenant: LocalContext,
    grant: { id: string; pluginId: string; permission: string; scope: string },
  ) {
    return this.deps.extensionRepo.grantPlugin(tenant, grant);
  }

  /** 撤销插件权限 */
  revoke(tenant: LocalContext, id: string) {
    return this.deps.extensionRepo.revokePluginGrant(tenant, id);
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