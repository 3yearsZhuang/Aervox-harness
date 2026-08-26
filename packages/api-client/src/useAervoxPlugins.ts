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
  };
}
