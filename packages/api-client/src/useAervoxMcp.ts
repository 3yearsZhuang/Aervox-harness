/**
 * Aervox｜思隅 @aervox/api-client — MCP 预设组合式 API（CAP-020）
 *
 * Web / Desktop 共用：预设 MCP 服务器清单、接入（Token）、工具同步、断开。
 * Token 只随 connect 请求上送，接口不回传原文（仅 tokenConfigured / tokenMasked）。
 */
import { ref } from 'vue';
import { getClientTransport } from './client-context.js';

export type { McpPresetServer as McpPresetDto, McpServerConfig as McpServerConfigDto, McpServerToolEntry as McpServerToolDto } from '@aervox/contracts';
import type { McpPresetServer as McpPresetDto, McpServerConfig as McpServerConfigDto, McpServerToolEntry as McpServerToolDto } from '@aervox/contracts';
import { mcpApi } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';

export function useAervoxMcp() {
  const transport = getClientTransport();
  const presets = ref<McpPresetDto[]>([]);
  const servers = ref<McpServerConfigDto[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const loadPresets = async (): Promise<void> => {
    loading.value = true;
    error.value = null;
    try {
      const res = await requestEndpoint(transport, mcpApi.presets);
      presets.value = res.presets ?? [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载预设 MCP 服务器失败';
    } finally {
      loading.value = false;
    }
  };

  const loadServers = async (): Promise<void> => {
    const res = await requestEndpoint(transport, mcpApi.servers);
    servers.value = res.servers ?? [];
  };

  const connectServer = async (serverId: string, token?: string): Promise<McpServerConfigDto> => {
    const res = await requestEndpoint(transport, mcpApi.connect, token ? { token } : {}, { serverId });
    return res.server;
  };

  const syncServer = async (serverId: string): Promise<McpServerConfigDto> => {
    const res = await requestEndpoint(transport, mcpApi.sync, undefined, { serverId });
    return res.server;
  };

  const disconnectServer = async (serverId: string): Promise<McpServerConfigDto> => {
    const res = await requestEndpoint(transport, mcpApi.disconnect, undefined, { serverId });
    return res.server;
  };

  const loadServerTools = async (serverId: string): Promise<McpServerToolDto[]> => {
    const res = await requestEndpoint(transport, mcpApi.tools, undefined, { serverId });
    return res.tools ?? [];
  };

  return {
    presets,
    servers,
    loading,
    error,
    loadPresets,
    loadServers,
    connectServer,
    syncServer,
    disconnectServer,
    loadServerTools,
  };
}
