/**
 * Aervox｜思隅 @aervox/api-client — 大语言模型与供应商能力组合式 API（CR-012）
 *
 * Web / Desktop 共用：通过统一 Transport 读写大语言模型与供应商配置、发起连通性测试。
 */
import { shallowRef } from 'vue';
import { getClientTransport } from './client-context.js';
import { createLLMConfigClient } from './llm-client.js';
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

export { toLLMConfigRequest } from './llm-client.js';

export function useAervoxLLM() {
  const api = createLLMConfigClient(getClientTransport());
  const presetProviders = shallowRef<PresetProviderInfo[]>([]);
  const loadProviders = async () => {
    presetProviders.value = (await api.providers()).providers;
    return presetProviders.value;
  };
  return { ...api, presetProviders, loadProviders };
}
