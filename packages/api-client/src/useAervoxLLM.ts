/**
 * Aervox｜思隅 @aervox/api-client — 大语言模型与供应商能力组合式 API（CR-012）
 *
 * Web / Desktop 共用：通过统一 Transport 读写大语言模型与供应商配置、发起连通性测试。
 */
import { getTransport } from './transport';

export type LLMProviderType =
  | 'ollama'
  | 'deepseek'
  | 'openai'
  | 'anthropic'
  | 'custom_openai';

export interface LLMConfigDto {
  enabled: boolean;
  providerType: LLMProviderType;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
  temperature: number;
  maxTokens?: number;
  settings?: Record<string, string | number | boolean>;
}

/** LLM 配置预设条目（多预设：含名称与激活标记） */
export interface LLMPresetDto extends LLMConfigDto {
  id: string;
  name: string;
  isActive: boolean;
}

/** LLM 配置预设列表响应 */
export interface LLMPresetListDto {
  presets: LLMPresetDto[];
  activeId: string | null;
}

export interface LLMTestConnectionInput {
  providerType: LLMProviderType;
  baseUrl: string;
  apiKey?: string;
  modelId: string;
}

export interface LLMTestConnectionResultDto {
  ok: boolean;
  latencyMs: number;
  message: string;
  availableModels?: string[];
}

export interface PresetProviderInfo {
  id: LLMProviderType;
  name: string;
  description: string;
  defaultBaseUrl: string;
  recommendedModels: string[];
  requiresApiKey: boolean;
}

export const PRESET_PROVIDERS: PresetProviderInfo[] = [
  {
    id: 'ollama',
    name: 'Ollama (本地模型)',
    description: '运行在本地机器的 Ollama 服务，默认免 API Key',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    recommendedModels: ['llama3.2', 'qwen2.5', 'deepseek-r1:8b', 'mistral'],
    requiresApiKey: false,
  },
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    description: 'DeepSeek 开放平台 API',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    recommendedModels: ['deepseek-chat', 'deepseek-reasoner'],
    requiresApiKey: true,
  },
  {
    id: 'openai',
    name: 'OpenAI 官方',
    description: 'OpenAI 官方 API 服务',
    defaultBaseUrl: 'https://api.openai.com/v1',
    recommendedModels: ['gpt-4o', 'gpt-4o-mini', 'o3-mini', 'gpt-4-turbo'],
    requiresApiKey: true,
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    description: 'Anthropic Claude API 服务',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    recommendedModels: [
      'claude-3-5-sonnet-20241022',
      'claude-3-5-haiku-20241022',
      'claude-3-opus-20240229',
    ],
    requiresApiKey: true,
  },
  {
    id: 'custom_openai',
    name: '自定义 OpenAI 兼容接口',
    description: '兼容 OpenAI 协议的第三方中转或自建 vLLM / LMDeploy 服务',
    defaultBaseUrl: 'http://127.0.0.1:8000/v1',
    recommendedModels: ['default'],
    requiresApiKey: false,
  },
];

/**
 * Electron IPC only accepts structured-cloneable values. Vue may hand this
 * composable a reactive proxy, so copy the object at the transport boundary.
 */
export function toLLMConfigRequest(body: LLMConfigDto): LLMConfigDto {
  return {
    enabled: body.enabled,
    providerType: body.providerType,
    baseUrl: body.baseUrl,
    apiKey: body.apiKey,
    modelId: body.modelId,
    temperature: body.temperature,
    maxTokens: body.maxTokens,
    settings: body.settings ? { ...body.settings } : {},
  };
}

export function useAervoxLLM() {
  const transport = getTransport();

  /** 读取当前租户的大语言模型与供应商配置 */
  const getConfig = async (): Promise<LLMConfigDto> =>
    transport.request<LLMConfigDto>('GET', '/v1/llm/config');

  /** 保存大语言模型与供应商配置 */
  const saveConfig = async (body: LLMConfigDto): Promise<LLMConfigDto> =>
    transport.request<LLMConfigDto>('PUT', '/v1/llm/config', toLLMConfigRequest(body));

  /** 测试模型供应商连通性 */
  const testConnection = async (
    input: LLMTestConnectionInput,
  ): Promise<LLMTestConnectionResultDto> =>
    transport.request<LLMTestConnectionResultDto>('POST', '/v1/llm/test-connection', input);

  /** 列出大语言模型配置预设（含激活标记） */
  const listPresets = async (): Promise<LLMPresetListDto> =>
    transport.request<LLMPresetListDto>('GET', '/v1/llm/presets');

  /** 新建大语言模型配置预设 */
  const createPreset = async (name: string, config: LLMConfigDto): Promise<LLMPresetDto> =>
    transport.request<LLMPresetDto>('POST', '/v1/llm/presets', {
      name,
      config: toLLMConfigRequest(config),
    });

  /** 激活指定大语言模型配置预设 */
  const activatePreset = async (presetId: string): Promise<LLMPresetDto> =>
    transport.request<LLMPresetDto>('POST', `/v1/llm/presets/${encodeURIComponent(presetId)}/activate`);

  /** 删除指定大语言模型配置预设 */
  const deletePreset = async (presetId: string): Promise<unknown> =>
    transport.request<unknown>('DELETE', `/v1/llm/presets/${encodeURIComponent(presetId)}`);

  return {
    getConfig,
    saveConfig,
    testConnection,
    listPresets,
    createPreset,
    activatePreset,
    deletePreset,
    presetProviders: PRESET_PROVIDERS,
  };
}
