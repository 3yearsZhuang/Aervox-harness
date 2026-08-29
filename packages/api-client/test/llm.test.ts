import { reactive } from 'vue';
import { describe, expect, it } from 'vitest';
import { configureAervoxClient, type AervoxTransport } from '../src/transport';
import { PRESET_PROVIDERS, useAervoxLLM } from '../src/useAervoxLLM';

describe('useAervoxLLM & PRESET_PROVIDERS (CR-012)', () => {
  it('预置供应商定义完整且包含推荐模型与 BaseURL', () => {
    expect(PRESET_PROVIDERS.length).toBeGreaterThanOrEqual(4);

    const ollama = PRESET_PROVIDERS.find((p) => p.id === 'ollama');
    expect(ollama).toBeDefined();
    expect(ollama?.defaultBaseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(ollama?.requiresApiKey).toBe(false);
    expect(ollama?.recommendedModels).toContain('llama3.2');

    const deepseek = PRESET_PROVIDERS.find((p) => p.id === 'deepseek');
    expect(deepseek).toBeDefined();
    expect(deepseek?.defaultBaseUrl).toBe('https://api.deepseek.com/v1');
    expect(deepseek?.requiresApiKey).toBe(true);
    expect(deepseek?.recommendedModels).toContain('deepseek-chat');

    const openai = PRESET_PROVIDERS.find((p) => p.id === 'openai');
    expect(openai).toBeDefined();
    expect(openai?.defaultBaseUrl).toBe('https://api.openai.com/v1');
    expect(openai?.requiresApiKey).toBe(true);

    const anthropic = PRESET_PROVIDERS.find((p) => p.id === 'anthropic');
    expect(anthropic).toBeDefined();
    expect(anthropic?.defaultBaseUrl).toBe('https://api.anthropic.com/v1');
    expect(anthropic?.requiresApiKey).toBe(true);
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
