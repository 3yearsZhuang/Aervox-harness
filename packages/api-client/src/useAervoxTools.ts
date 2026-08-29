/**
 * Aervox｜思隅 @aervox/api-client — 工具与 MCP 组合式 API（T-04 / AST-04 / PET-05）
 *
 * Web / Desktop 共用：通过统一 Transport 访问系统级工具注册表、启停、注册、注销与 MCP 测试调用。
 */
import { ref } from 'vue';
import { getTransport } from './transport';

export interface ToolRegistrationDto {
  id: string;
  name: string;
  description: string;
  category: 'memory' | 'search' | 'learning' | 'diary' | 'system' | 'external' | string;
  safetyLevel?: 'read_only' | 'write_with_approval' | 'privileged' | string;
  replay?: 'never' | 'safe' | string | null;
  requiredPermissionsJson?: unknown;
  inputSchemaJson?: unknown;
  builtin: number | boolean;
  pluginId?: string | null;
  enabled: number | boolean;
  gatingConditionsJson?: unknown;
  priority?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface RegisterToolInputDto {
  id: string;
  name: string;
  description: string;
  category?: string;
  safetyLevel?: 'read_only' | 'write_with_approval' | 'privileged' | string;
  replay?: 'never' | 'safe';
  requiredPermissions?: unknown;
  inputSchema?: unknown;
  builtin?: boolean;
  pluginId?: string | null;
  gatingConditions?: unknown;
  priority?: number;
}

export interface McpToolListItemDto {
  name: string;
  description: string;
  inputSchema?: unknown;
  readonly?: boolean;
}

export interface McpCallToolResultDto {
  content?: Array<{ type: string; text?: string; data?: unknown }>;
  isError?: boolean;
  [key: string]: unknown;
}

export function useAervoxTools() {
  const transport = getTransport();
  const tools = ref<ToolRegistrationDto[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  const loadTools = async (): Promise<void> => {
    loading.value = true;
    error.value = null;
    try {
      const res = await transport.request<{ items: ToolRegistrationDto[] }>('GET', '/v1/tools');
      tools.value = res.items ?? [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : '加载工具注册表失败';
    } finally {
      loading.value = false;
    }
  };

  const setToolEnabled = async (id: string, enabled: boolean): Promise<ToolRegistrationDto> => {
    const res = await transport.request<ToolRegistrationDto>('PATCH', `/v1/tools/${encodeURIComponent(id)}`, {
      enabled,
    });
    await loadTools();
    return res;
  };

  const registerTool = async (input: RegisterToolInputDto): Promise<ToolRegistrationDto> => {
    const res = await transport.request<ToolRegistrationDto>('POST', '/v1/tools', input);
    await loadTools();
    return res;
  };

  const unregisterTool = async (id: string): Promise<void> => {
    await transport.request('DELETE', `/v1/tools/${encodeURIComponent(id)}`);
    await loadTools();
  };

  const callTool = async (
    id: string,
    args: unknown = {},
    approval = false,
  ): Promise<McpCallToolResultDto> =>
    transport.request<McpCallToolResultDto>('POST', `/v1/tools/${encodeURIComponent(id)}/call`, {
      arguments: args,
      approval,
    });

  const loadMcpList = async (): Promise<McpToolListItemDto[]> => {
    const res = await transport.request<{ tools: McpToolListItemDto[] }>('GET', '/v1/tools/mcp/list');
    return res.tools ?? [];
  };

  return {
    tools,
    loading,
    error,
    loadTools,
    setToolEnabled,
    registerTool,
    unregisterTool,
    callTool,
    loadMcpList,
  };
}
