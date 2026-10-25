/**
 * Aervox｜思隅 @aervox/api-client — 大语言模型与供应商能力组合式 API（CR-012）
 *
 * Web / Desktop 共用：通过统一 Transport 读写大语言模型与供应商配置、发起连通性测试。
 */
import { shallowRef } from 'vue';
import { getClientTransport } from './client-context.js';
import { llmApi } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';
import type {
  LLMProviderType,
  LLMConfig as LLMConfigDto,
  LLMPreset as LLMPresetDto,
  LLMPresetListResponse as LLMPresetListDto,
  LLMTestConnectionRequest as LLMTestConnectionInput,
  LLMTestConnectionResponse as LLMTestConnectionResultDto,
} from '@aervox/contracts';

export type {
  LLMProviderType,
  LLMConfigDto,
  LLMPresetDto,
  LLMPresetListDto,
  LLMTestConnectionInput,
  LLMTestConnectionResultDto,
};


export type { LLMProviderCatalogEntry as PresetProviderInfo } from '@aervox/contracts';
import type { LLMProviderCatalogEntry as PresetProviderInfo } from '@aervox/contracts';

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
  const transport = getClientTransport();
  const presetProviders = shallowRef<PresetProviderInfo[]>([]);
  const loadProviders = async () => {
    presetProviders.value = (await requestEndpoint(transport, llmApi.providers)).providers;
    return presetProviders.value;
  };

  /** 读取本地实例的大语言模型与供应商配置 */
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
    presetProviders,
    loadProviders,
  };
}
