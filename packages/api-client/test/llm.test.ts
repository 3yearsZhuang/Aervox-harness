import { reactive } from 'vue';
import { describe, expect, it } from 'vitest';
import { configureAervoxClient, type AervoxTransport } from '../src/transport';
import { useAervoxLLM } from '../src/useAervoxLLM';

describe('useAervoxLLM & PRESET_PROVIDERS (CR-012)', () => {
  it('loads provider metadata from the host rather than maintaining a local catalog', async () => {
    const provider = { id: 'injected', name: 'Injected', description: 'test', protocol: 'openai-compat', defaultBaseUrl: 'http://127.0.0.1:9000/v1', recommendedModels: ['test-model'], requiresApiKey: false, isLocal: true, available: true };
    configureAervoxClient({ transport: { request: async () => ({ generation: 3, providers: [provider] }) } as AervoxTransport });
    const api = useAervoxLLM();
    expect(api.presetProviders.value).toEqual([]);
    await api.loadProviders();
    expect(api.presetProviders.value).toEqual([provider]);
  });

  it('保存时将 Vue 响应式配置规范化为可经 Electron IPC 克隆的纯数据', async () => {
    let sentBody: unknown;
    const transport: AervoxTransport = {
      request: async <T>(_method: string, _path: string, body?: unknown): Promise<T> => {
        sentBody = body;
        structuredClone(body);
        return body as T;
      },
      streamTurn: async () => undefined,
      submitQuestionAnswers: async () => undefined,
    };
    configureAervoxClient({ transport });

    const config = reactive({
      enabled: true,
      providerType: 'deepseek' as const,
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      modelId: 'deepseek-chat',
      temperature: 0.7,
      maxTokens: 4096,
      settings: { retry: 1 },
    });

    await useAervoxLLM().saveConfig(config);

    expect(sentBody).toEqual({ ...config, settings: { retry: 1 } });
  });
});
