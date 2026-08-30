/**
 * Aervox｜思隅 @aervox/api-client — MCP 预设组合式 API（CAP-020）
 *
 * Web / Desktop 共用：预设 MCP 服务器清单、接入（Token）、工具同步、断开。
 * Token 只随 connect 请求上送，接口不回传原文（仅 tokenConfigured / tokenMasked）。
 */
import { ref } from 'vue';
import { getTransport } from './transport';

export interface McpPresetDto {
  id: string;
  name: string;
  description: string;
  transport: string;
  endpointUrl: string;
  authType: string;
  protocolVersion: string;
  homepage: string;
  docsUrl: string;
  tokenApplyUrl: string;
  regionNote?: string;
  rateLimitNote?: string;
  sourceUrl: string;
  configured: boolean;
  enabled: boolean;
  status: string;
  toolCount: number;
  tokenConfigured: boolean;
  tokenMasked?: string | null;
  lastSyncAt?: string | null;
  lastError?: string | null;
}

export interface McpServerConfigDto {
  id: string;
  name: string;
  transport: string;
  endpointUrl: string;
  authType: string;
  enabled: boolean;
  isPreset: boolean;
  status: string;
  toolCount: number;
  tokenConfigured: boolean;
  tokenMasked?: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerToolDto {
  id: string;
  name: string;
  description: string;
  safetyLevel: string;
  enabled: boolean;
  inputSchema?: unknown;
}

export function useAervoxMcp() {
  const presets = ref<McpPresetDto[]>([]);
  const servers = ref<McpServerConfigDto[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const loadPresets = async (): Promise<void> => {
    loading.value = true;
    error.value = null;
    try {
      const res = await getTransport().request<{ presets: McpPresetDto[] }>(
        'GET',
        '/v1/mcp/presets',
      );
      presets.value = res.presets ?? [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载预设 MCP 服务器失败';
    } finally {
      loading.value = false;
    }
  };

  const loadServers = async (): Promise<void> => {
    const res = await getTransport().request<{ servers: McpServerConfigDto[] }>(
      'GET',
      '/v1/mcp/servers',
    );
    servers.value = res.servers ?? [];
  };

  const connectServer = async (serverId: string, token?: string): Promise<McpServerConfigDto> => {
    const res = await getTransport().request<{ server: McpServerConfigDto }>(
      'POST',
      `/v1/mcp/servers/${encodeURIComponent(serverId)}/connect`,
      token ? { token } : {},
    );
    return res.server;
  };

  const syncServer = async (serverId: string): Promise<McpServerConfigDto> => {
    const res = await getTransport().request<{ server: McpServerConfigDto }>(
      'POST',
      `/v1/mcp/servers/${encodeURIComponent(serverId)}/sync`,
    );
    return res.server;
  };

  const disconnectServer = async (serverId: string): Promise<McpServerConfigDto> => {
    const res = await getTransport().request<{ server: McpServerConfigDto }>(
      'POST',
      `/v1/mcp/servers/${encodeURIComponent(serverId)}/disconnect`,
    );
    return res.server;
  };

  const loadServerTools = async (serverId: string): Promise<McpServerToolDto[]> => {
    const res = await getTransport().request<{ tools: McpServerToolDto[] }>(
      'GET',
      `/v1/mcp/servers/${encodeURIComponent(serverId)}/tools`,
    );
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
