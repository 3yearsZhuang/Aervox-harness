/**
 * Aervox｜思隅 @aervox/api-client — 插件 Config / Page 组合式 API（CR-006）
 *
 * Web / Desktop 共用：通过统一 Transport 访问插件配置、Schema、Page 与启停。
 */
import { ref } from 'vue';
import type {
  PluginConfigField,
  PluginConfigSnapshot,
  PluginPage,
  PluginPackageInspection,
  PluginMarketItem,
  PluginPackageExportResponse,
} from '@aervox/contracts';
import { PLUGIN_SENSOR_PERMISSION } from '@aervox/contracts';
import { getTransport } from './transport';

export type PluginPackageInspectionDto = PluginPackageInspection;
export type PluginMarketItemDto = PluginMarketItem;
export type PluginPackageExportDto = PluginPackageExportResponse;

export interface PluginSummaryDto {
  id: string;
  publisher: string;
  version: string;
  checksum: string;
  signature?: string | null;
  permissions?: unknown;
  installSource: string;
  enabled: number;
  configSchemaJson?: unknown;
  configSchemaVersion?: number;
  /** CR-032：主动智能声明（spec.proactive，含 sensors/triggers） */
  proactiveSpecJson?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface PluginGrantDto {
  id: string;
  pluginId: string;
  permission: string;
  scope: string;
  grantedAt: string;
}

export interface PluginPageDto extends PluginPage {
  id: string;
}

/** 安装插件入参（POST /v1/plugins；tools/skills 为插件声明清单，随安装注册） */
export interface PluginInstallInputDto {
  id: string;
  publisher: string;
  version: string;
  checksum?: string;
  signature?: string | null;
  permissions?: unknown;
  installSource?: string;
  /** 声明工具：每项含 name/description/category，安装时以 `<pluginId>.<name>` 注册进工具注册表 */
  tools?: unknown[];
  /** 声明技能：每项含 name/content（SKILL.md 全文），安装时落盘并只读注册 */
  skills?: Array<{ name: string; description?: string; content: string }>;
  /** CR-032：主动智能声明（须符合 pluginProactiveSpecSchema，非法值服务端 fail-closed 拒装） */
  proactiveSpec?: unknown;
}

export function useAervoxPlugins() {
  const transport = getTransport();
  const plugins = ref<PluginSummaryDto[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const loadPlugins = async (): Promise<void> => {
    loading.value = true;
    error.value = null;
    try {
      const res = await transport.request<{ items: PluginSummaryDto[] }>('GET', '/v1/plugins');
      plugins.value = res.items ?? [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载插件失败';
    } finally {
      loading.value = false;
    }
  };

  const getConfigSchema = async (pluginId: string): Promise<{ schemaVersion: number; fields: PluginConfigField[] }> =>
    transport.request<{ schemaVersion: number; fields: PluginConfigField[] }>(
      'GET',
      `/v1/plugins/${encodeURIComponent(pluginId)}/config/schema`,
    );

  const getConfig = async (pluginId: string): Promise<PluginConfigSnapshot> =>
    transport.request<PluginConfigSnapshot>(
      'GET',
      `/v1/plugins/${encodeURIComponent(pluginId)}/config`,
    );

  const saveConfig = async (
    pluginId: string,
    input: { revision: number; values: Record<string, unknown>; secretValues?: Record<string, string | null> },
  ): Promise<PluginConfigSnapshot> =>
    transport.request<PluginConfigSnapshot>(
      'PUT',
      `/v1/plugins/${encodeURIComponent(pluginId)}/config`,
      input,
    );

  const resetConfig = async (pluginId: string): Promise<PluginConfigSnapshot> =>
    transport.request<PluginConfigSnapshot>(
      'POST',
      `/v1/plugins/${encodeURIComponent(pluginId)}/config/reset`,
    );

  const listPages = async (pluginId: string): Promise<PluginPageDto[]> => {
    const res = await transport.request<{ pages: PluginPageDto[] }>(
      'GET',
      `/v1/plugins/${encodeURIComponent(pluginId)}/pages`,
    );
    return res.pages ?? [];
  };

  const setPluginEnabled = async (pluginId: string, enabled: boolean): Promise<void> => {
    await transport.request('PATCH', `/v1/plugins/${encodeURIComponent(pluginId)}`, { enabled });
  };

  /** CR-032：授予插件感知源授权（permission=PLUGIN_SENSOR_PERMISSION，scope=sourceId） */
  const grantSensor = async (pluginId: string, sourceId: string): Promise<PluginGrantDto> =>
    transport.request<PluginGrantDto>(
      'POST',
      `/v1/plugins/${encodeURIComponent(pluginId)}/grants`,
      { permission: PLUGIN_SENSOR_PERMISSION, scope: sourceId },
    );

  /** CR-032：撤销插件感知源授权 */
  const revokeSensorGrant = async (pluginId: string, grantId: string): Promise<void> => {
    await transport.request('DELETE', `/v1/plugins/${encodeURIComponent(pluginId)}/grants/${encodeURIComponent(grantId)}`);
  };

  /** CR-032：列出插件有效感知源授权（撤销需 grantId） */
  const listSensorGrants = async (pluginId: string): Promise<PluginGrantDto[]> => {
    const res = await transport.request<{ items: PluginGrantDto[] }>(
      'GET',
      `/v1/plugins/${encodeURIComponent(pluginId)}/grants`,
    );
    return res.items ?? [];
  };

  /** CR-032：查询感知源是否已授权 */
  const hasSensorGrant = async (pluginId: string, sourceId: string): Promise<boolean> => {
    const res = await transport.request<{ granted: boolean }>(
      'GET',
      `/v1/plugins/${encodeURIComponent(pluginId)}/permissions/${PLUGIN_SENSOR_PERMISSION}?scope=${encodeURIComponent(sourceId)}`,
    );
    return Boolean(res.granted);
  };

  /** 安装插件：登记声明并联动工具/技能注册（API 幂等），成功后刷新列表 */
  const installPlugin = async (input: PluginInstallInputDto): Promise<PluginSummaryDto> => {
    const res = await transport.request<PluginSummaryDto>('POST', '/v1/plugins', input);
    await loadPlugins();
    return res;
  };

  /** 预检插件分发包（PRD CAP-020 验收门禁） */
  const inspectPackage = async (
    packageBase64: string,
  ): Promise<PluginPackageInspectionDto> => {
    return transport.request<PluginPackageInspectionDto>(
      'POST',
      '/v1/plugins/inspect-package',
      { packageBase64 },
    );
  };

  /** 从分发包安装插件（.aervox-plugin） */
  const installPackage = async (
    packageBase64: string,
    overwrite: boolean = false,
  ): Promise<PluginSummaryDto> => {
    const res = await transport.request<PluginSummaryDto>(
      'POST',
      '/v1/plugins/install-package',
      { packageBase64, overwrite },
    );
    await loadPlugins();
    return res;
  };

  /** 导出插件分发包（.aervox-plugin）元数据及 Base64 内容 */
  const exportPackage = async (pluginId: string): Promise<PluginPackageExportDto> => {
    return transport.request<PluginPackageExportDto>(
      'GET',
      `/v1/plugins/${encodeURIComponent(pluginId)}/export`,
    );
  };

  /** 触发浏览器直接下载插件分发包文件 */
  const downloadPackage = async (pluginId: string): Promise<void> => {
    const exp = await exportPackage(pluginId);
    const byteCharacters = atob(exp.packageBase64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exp.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  /** 获取官方与出厂插件集市条目 */
  const listMarket = async (): Promise<PluginMarketItemDto[]> => {
    const res = await transport.request<{ items: PluginMarketItemDto[] }>(
      'GET',
      '/v1/plugins/market',
    );
    return res.items ?? [];
  };

  /** 从集市一键安装插件 */
  const installFromMarket = async (pluginId: string): Promise<PluginSummaryDto> => {
    const res = await transport.request<PluginSummaryDto>(
      'POST',
      `/v1/plugins/market/${encodeURIComponent(pluginId)}/install`,
    );
    await loadPlugins();
    return res;
  };

  return {
    plugins,
    loading,
    error,
    loadPlugins,
    getConfigSchema,
    getConfig,
    saveConfig,
    resetConfig,
    listPages,
    setPluginEnabled,
    installPlugin,
    inspectPackage,
    installPackage,
    exportPackage,
    downloadPackage,
    listMarket,
    installFromMarket,
    grantSensor,
    revokeSensorGrant,
    listSensorGrants,
    hasSensorGrant,
  };
}
