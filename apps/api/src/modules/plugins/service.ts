/**
 * Aervox｜思隅 @aervox/api — CAP-020 插件运行时（生命周期 + 权限 + 工具联动）
 *
 * 将 plugins 表（安装态/激活态）与 tool_registrations 联动：
 * - 安装：createPlugin + 为该插件注册声明工具（pluginId 关联，非内置）；
 * - 启停：setPluginEnabled 联动其工具 enabled；
 * - 卸载：先注销插件工具，再 deletePlugin（plugin_grants 级联清理）；
 * - 权限：grant/revoke/hasPluginPermission 复用既有仓储；门控求值默认实现
 *   与 tools 模块一致（defaultGatingEvaluator）。
 *
 * 规则依据：docs/explanation/reference-design-transfer.md §4.7 AST-04（安装态与激活态分离）。
 */
import {
  SqliteExtensionRepository,
  SqliteToolRegistryRepository,
  type PluginModel,
  type TenantContext,
} from "@aervox/database";

/** 插件声明的工具（安装时注册进 tool_registrations） */
export interface PluginDeclaredTool {
  /** 工具标识；缺省以 name 作为 id 基底 */
  id?: string;
  name: string;
  description: string;
  category: string;
  safetyLevel?: string;
  requiredPermissions?: unknown;
  inputSchema?: unknown;
  gatingConditions?: unknown;
  priority?: number;
}

export interface PluginServiceDeps {
  extensionRepo: SqliteExtensionRepository;
  registry: SqliteToolRegistryRepository;
}

export class PluginService {
  constructor(private readonly deps: PluginServiceDeps) {}

  /** 列出全部插件 */
  listPlugins(): Promise<PluginModel[]> {
    return this.deps.extensionRepo.listPlugins();
  }

  /** 安装：登记插件 + 同步声明工具（幂等） */
  async installPlugin(plugin: {
    id: string;
    publisher: string;
    version: string;
    checksum?: string;
    signature?: string | null;
    permissions?: unknown;
    installSource?: string;
    tools?: PluginDeclaredTool[];
  }): Promise<PluginModel> {
    const created = await this.deps.extensionRepo.createPlugin({
      id: plugin.id,
      publisher: plugin.publisher,
      version: plugin.version,
      checksum: plugin.checksum ?? `sha256:${plugin.id}:${plugin.version}`,
      signature: plugin.signature ?? null,
      permissions: plugin.permissions ?? [],
      installSource: plugin.installSource ?? "registry",
    });

    for (const tool of plugin.tools ?? []) {
      const baseId = tool.id ?? tool.name;
      const toolId = baseId.startsWith(`${plugin.id}.`)
        ? baseId
        : `${plugin.id}.${baseId}`;
      await this.deps.registry.registerTool({
        id: toolId,
        name: tool.name,
        description: tool.description,
        category: tool.category,
        safetyLevel: tool.safetyLevel,
        requiredPermissions: tool.requiredPermissions,
        inputSchema: tool.inputSchema,
        builtin: false,
        pluginId: plugin.id,
        gatingConditions: tool.gatingConditions,
        priority: tool.priority ?? 0,
      });
    }

    return created;
  }

  /** 启停插件 + 联动其工具 enabled */
  async setEnabled(id: string, enabled: boolean): Promise<PluginModel | null> {
    const updated = await this.deps.extensionRepo.setPluginEnabled(id, enabled);
    if (!updated) return null;
    const tools = await this.deps.registry.listTools();
    for (const tool of tools.filter((t) => t.pluginId === id)) {
      await this.deps.registry.setEnabled(tool.id, enabled);
    }
    return updated;
  }

  /** 卸载：先注销插件工具，再删插件（grants 级联清理） */
  async uninstallPlugin(id: string): Promise<boolean> {
    const tools = await this.deps.registry.listTools();
    for (const tool of tools.filter((t) => t.pluginId === id)) {
      await this.deps.registry.unregisterTool(tool.id);
    }
    return this.deps.extensionRepo.deletePlugin(id);
  }

  /** 授予插件权限 */
  grant(
    tenant: TenantContext,
    grant: { id: string; pluginId: string; permission: string; scope: string },
  ) {
    return this.deps.extensionRepo.grantPlugin(tenant, grant);
  }

  /** 撤销插件权限 */
  revoke(tenant: TenantContext, id: string) {
    return this.deps.extensionRepo.revokePluginGrant(tenant, id);
  }

  /** 查询插件是否具备指定权限 */
  hasPermission(tenant: TenantContext, pluginId: string, permission: string) {
    return this.deps.extensionRepo.hasPluginPermission(tenant, pluginId, permission);
  }
}