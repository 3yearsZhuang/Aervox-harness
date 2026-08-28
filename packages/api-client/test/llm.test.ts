import { describe, expect, it } from 'vitest';
import { PRESET_PROVIDERS } from '../src/useAervoxLLM';

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
});
