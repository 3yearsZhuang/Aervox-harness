import { reactive } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { createLLMConfigClient, type AervoxTransport } from '../src/transport.js';
import { llmApi } from '@aervox/contracts';

const config = { enabled: true, providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', modelId: 'model', temperature: 0.7, maxTokens: 4096, settings: {} };
const preset = { ...config, id: 'preset/a?b', name: 'Fixture', isActive: true };
function client(handler: (method: string, path: string, body?: unknown, options?: Parameters<AervoxTransport['request']>[3]) => Promise<unknown>) {
  const transport: AervoxTransport = { request: async <T>(method: string, path: string, body?: unknown, options?: Parameters<AervoxTransport['request']>[3]) =>
    (options === undefined ? handler(method, path, body) : handler(method, path, body, options)) as Promise<T> };
  return createLLMConfigClient(transport);
}

describe('Vue-free LLM configuration client', () => {
  it('uses all shared descriptors and preserves literal preset ids and deletion fields', async () => {
    const request = vi.fn(async (_method: string, path: string) => path.endsWith('/providers') ? { generation: 1, providers: [] }
      : path.endsWith('/test-connection') ? { ok: false, latencyMs: 0, message: 'not reachable' }
        : path.endsWith('/activate') ? preset : path.endsWith('/presets') ? { presets: [preset], activeId: preset.id } : config);
    const api = client(request);
    expect(await api.providers()).toEqual({ generation: 1, providers: [] });
    expect(await api.getConfig()).toEqual(config);
    expect(await api.saveConfig(config)).toEqual(config);
    expect(await api.testConnection(config)).toMatchObject({ ok: false });
    expect(await api.listPresets()).toEqual({ presets: [preset], activeId: preset.id });
    request.mockResolvedValueOnce(preset);
    expect(await api.createPreset('Fixture', config)).toEqual(preset);
    expect(await api.activatePreset(preset.id)).toEqual(preset);
    request.mockResolvedValueOnce({ deleted: true, presetId: preset.id });
    expect(await api.deletePreset(preset.id)).toEqual({ deleted: true, presetId: preset.id });
    expect(request.mock.calls.map(([method, path]) => [method, path])).toEqual([
      ['GET', '/v1/llm/providers'], ['GET', '/v1/llm/config'], ['PUT', '/v1/llm/config'],
      ['POST', '/v1/llm/test-connection'], ['GET', '/v1/llm/presets'], ['POST', '/v1/llm/presets'],
      ['POST', '/v1/llm/presets/preset%2Fa%3Fb/activate'], ['DELETE', '/v1/llm/presets/preset%2Fa%3Fb'],
    ]);
  });

  it('copies reactive settings for structured-clone transports without injecting omitted defaults', async () => {
    const request = vi.fn(async (_method: string, _path: string, body?: unknown) => { structuredClone(body); return config; });
    const input = reactive({ enabled: true, providerType: 'ollama', baseUrl: config.baseUrl, modelId: 'model', settings: { count: 1 } });
    await client(request).saveConfig(input);
    expect(request.mock.calls[0]![2]).toMatchObject({ settings: { count: 1 } });
    expect(request.mock.calls[0]![2]).toHaveProperty('temperature', undefined);
    expect(request.mock.calls[0]![2]).toHaveProperty('maxTokens', undefined);
  });

  it('rejects invalid writes and empty ids before invoking transport', async () => {
    const request = vi.fn(async () => config);
    const api = client(request);
    await expect(api.saveConfig({ ...config, modelId: '   ' })).rejects.toThrow();
    await expect(api.saveConfig({ ...config, settings: { nested: {} } })).rejects.toThrow();
    await expect(api.createPreset('', config)).rejects.toThrow();
    await expect(api.testConnection({ ...config, providerType: '' })).rejects.toThrow();
    await expect(api.activatePreset('')).rejects.toThrow();
    await expect(api.deletePreset('')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['getConfig', 'saveConfig', 'testConnection', 'listPresets', 'createPreset', 'activatePreset', 'deletePreset'] as const)(
    'rejects a malformed successful %s response', async method => {
      const api = client(async () => ({}));
      const result = method === 'saveConfig' || method === 'testConnection' ? api[method](config)
        : method === 'createPreset' ? api.createPreset('Fixture', config)
          : method === 'activatePreset' || method === 'deletePreset' ? api[method]('id') : api[method]();
      await expect(result).rejects.toThrow();
    });

  it('preserves a negative deletion acknowledgement for the caller to handle', async () => {
    expect(await client(async () => ({ deleted: false, presetId: 'id' })).deletePreset('id')).toEqual({ deleted: false, presetId: 'id' });
  });

  it('passes cancellation out of band and ignores a late transport result', async () => {
    let finish!: (value: unknown) => void;
    const request = vi.fn(() => new Promise<unknown>(resolve => { finish = resolve; }));
    const api = client(request);
    const controller = new AbortController();
    const pending = api.getConfig(controller.signal);
    expect(request).toHaveBeenCalledWith('GET', llmApi.getConfig.path, undefined, { signal: controller.signal });
    const reason = new Error('owner closed');
    controller.abort(reason);
    finish(config);
    await expect(pending).rejects.toBe(reason);
    request.mockClear();
    await expect(api.listPresets(AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(request).not.toHaveBeenCalled();
  });
});
