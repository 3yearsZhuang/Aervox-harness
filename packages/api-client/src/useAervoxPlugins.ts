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
} from '@aervox/contracts';
import { getTransport } from './transport';

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
  createdAt: string;
  updatedAt: string;
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

  /** 安装插件：登记声明并联动工具/技能注册（API 幂等），成功后刷新列表 */
  const installPlugin = async (input: PluginInstallInputDto): Promise<PluginSummaryDto> => {
    const res = await transport.request<PluginSummaryDto>('POST', '/v1/plugins', input);
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
  };
}
