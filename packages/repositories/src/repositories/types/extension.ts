/**
 * Aervox｜思隅 @aervox/repositories — extension 仓储类型（自 types.ts 机械拆分）
 */
import type { CommunityContentModel, ExternalSourceModel, OrganizationModel, PluginGrantModel, PluginModel } from "./recovery-ledger.js";
import type { LocalContext } from "../../local-context.js";

export interface IExtensionRepository {
  createExternalSource(
    ctx: LocalContext,
    source: { id: string; provider: string; externalId: string; permissionScope: string; syncState?: string },
  ): Promise<ExternalSourceModel>;
  getExternalSource(ctx: LocalContext, id: string): Promise<ExternalSourceModel | null>;
  createPlugin(
    plugin: {
      id: string;
      publisher: string;
      version: string;
      checksum: string;
      signature?: string | null;
      permissions?: unknown;
      installSource?: string;
      enabled?: number;
      configSchemaJson?: unknown;
      configSchemaVersion?: number;
      proactiveSpecJson?: unknown;
    },
  ): Promise<PluginModel>;
  listPlugins(): Promise<PluginModel[]>;
  getPlugin(id: string): Promise<PluginModel | null>;
  /** CR-006：登记插件配置 Schema（系统级） */
  setPluginConfigSchema(id: string, schema: unknown, schemaVersion: number): Promise<PluginModel | null>;

  /** CAP-020：启停插件（联动其声明的工具启停） */
  setPluginEnabled(id: string, enabled: boolean): Promise<PluginModel | null>;
  /** CAP-020：卸载插件（需先注销其工具） */
  deletePlugin(id: string): Promise<boolean>;
  grantPlugin(
    ctx: LocalContext,
    grant: { id: string; pluginId: string; permission: string; scope: string; grantedAt?: string },
  ): Promise<PluginGrantModel>;
  revokePluginGrant(ctx: LocalContext, id: string): Promise<PluginGrantModel | null>;
  hasPluginPermission(ctx: LocalContext, pluginId: string, permission: string): Promise<boolean>;
  /** CR-032：带 scope 的授权检查（感知源授权） */
  hasPluginGrant(ctx: LocalContext, pluginId: string, permission: string, scope: string): Promise<boolean>;
  /** CR-032：按 permission 批量列出有效授权（感知源授权矩阵） */
  listActiveGrantsByPermission(ctx: LocalContext, permission: string): Promise<PluginGrantModel[]>;
  createCommunityContent(
    ctx: LocalContext,
    content: { id: string; authorId: string; type: string; status?: string; reviewState?: string; visibility?: string },
  ): Promise<CommunityContentModel>;
  getCommunityContent(ctx: LocalContext, id: string): Promise<CommunityContentModel | null>;
  createOrganization(
    ctx: LocalContext,
    org: { id: string; ownerId: string; memberScope?: string; policyVersion: string },
  ): Promise<OrganizationModel>;
  getOrganization(ctx: LocalContext, id: string): Promise<OrganizationModel | null>;
}

export interface PluginConfigModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  pluginId: string;
  /** 非敏感配置值 */
  valuesJson: unknown;
  /** 已配置 secret 字段键 */
  secretKeysJson: string[];
  schemaVersion: number;
  revision: number;
  orphanedValuesJson?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PluginSecretModel {
  id: string;
  workspaceId?: string;
  subjectUserId?: string;
  pluginId: string;
  fieldKey: string;
  valueJson: unknown;
  configured: number;
  createdAt: string;
  updatedAt: string;
}

export interface PluginPageModel {
  id: string;
  pluginId: string;
  pageId: string;
  title: unknown;
  description?: unknown;
  entry: string;
  capabilitiesJson: string[];
  checksum?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PluginConfigSaveInput {
  pluginId: string;
  schemaVersion: number;
  /** 期望 revision（-1 表示无条件写） */
  expectedRevision: number;
  values: Record<string, unknown>;
  secretKeys: string[];
  orphanedValues?: Record<string, unknown>;
}
