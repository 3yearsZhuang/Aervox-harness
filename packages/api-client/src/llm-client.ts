import {
  llmApi, llmConfigSchema, llmTestConnectionRequestSchema,
  type LLMConfig, type LLMTestConnectionRequest,
} from '@aervox/contracts';
import type { AervoxTransport } from './transport.js';
import { requestEndpoint } from './endpoint.js';

/** Copy reactive inputs before crossing structured-clone transports; the server owns defaults. */
export function toLLMConfigRequest(body: LLMConfig): LLMConfig {
  return {
    enabled: body.enabled, providerType: body.providerType, baseUrl: body.baseUrl, apiKey: body.apiKey,
    modelId: body.modelId, temperature: body.temperature, maxTokens: body.maxTokens,
    settings: body.settings ? { ...body.settings } : {},
  };
}
function configInput(input: unknown): LLMConfig {
  llmConfigSchema.parse(input);
  return toLLMConfigRequest(input as LLMConfig);
}
const options = (signal?: AbortSignal) => signal === undefined ? undefined : { signal };

/** Vue-free configuration operations shared by browser settings and the connected CLI. */
export function createLLMConfigClient(transport: AervoxTransport) {
  return {
    providers: (signal?: AbortSignal) => requestEndpoint(transport, llmApi.providers, undefined, undefined, undefined, options(signal)),
    getConfig: (signal?: AbortSignal) => requestEndpoint(transport, llmApi.getConfig, undefined, undefined, undefined, options(signal)),
    saveConfig: async (input: unknown, signal?: AbortSignal) => requestEndpoint(transport, llmApi.saveConfig, configInput(input), undefined, undefined, options(signal)),
    async testConnection(input: unknown, signal?: AbortSignal) {
      const parsed: LLMTestConnectionRequest = llmTestConnectionRequestSchema.parse(input);
      return requestEndpoint(transport, llmApi.testConnection, { ...parsed }, undefined, undefined, options(signal));
    },
    listPresets: (signal?: AbortSignal) => requestEndpoint(transport, llmApi.listPresets, undefined, undefined, undefined, options(signal)),
    createPreset: async (name: string, input: unknown, signal?: AbortSignal) => requestEndpoint(transport, llmApi.createPreset,
      { name, config: configInput(input) }, undefined, undefined, options(signal)),
    activatePreset: (presetId: string, signal?: AbortSignal) => requestEndpoint(transport, llmApi.activatePreset, undefined, { presetId }, undefined, options(signal)),
    deletePreset: (presetId: string, signal?: AbortSignal) => requestEndpoint(transport, llmApi.deletePreset, undefined, { presetId }, undefined, options(signal)),
  };
}
