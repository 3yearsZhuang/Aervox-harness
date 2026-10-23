import { describe, expect, it, vi } from 'vitest';
import { configureAervoxClient, type AervoxTransport } from '../src/transport.js';
import { useAervoxPlugins } from '../src/useAervoxPlugins.js';

const schema = { apiVersion: 'aervox.dev/v1' as const, kind: 'PluginConfigSchema' as const, schemaVersion: 1 as const, fields: [{ key: 'token', type: 'secret' as const, label: 'Token' }] };
const schemaResponse = { schemaVersion: 1, fields: schema.fields };
const snapshot = { pluginId: 'a/b?c#d', revision: 1, schemaVersion: 1, values: {}, secretFields: { token: { configured: true } }, orphanedValues: {}, issues: [] };
function client(handler: (method: string, path: string, body?: unknown) => Promise<unknown>) {
  const transport: AervoxTransport = { request: async <T>(method: string, path: string, body?: unknown) => handler(method, path, body) as Promise<T> };
  configureAervoxClient({ transport });
  return useAervoxPlugins();
}

describe('plugin configuration shared client', () => {
  it('uses all five descriptors, encodes plugin ids once and preserves omitted payload fields', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const api = client(async (method, path, body) => {
      calls.push([method, path, body]);
      return path.endsWith('/schema') ? schemaResponse : snapshot;
    });
    const id = 'a/b?c#d';
    expect(await api.getConfigSchema(id)).toMatchObject(schemaResponse);
    await api.registerConfigSchema(id, schema);
    expect(await api.getConfig(id)).toEqual(snapshot);
    expect(await api.saveConfig(id, { revision: 1 })).toEqual(snapshot);
    await api.resetConfig(id);
    expect(calls).toEqual([
      ['GET', '/v1/plugins/a%2Fb%3Fc%23d/config/schema', undefined],
      ['PUT', '/v1/plugins/a%2Fb%3Fc%23d/config/schema', schema],
      ['GET', '/v1/plugins/a%2Fb%3Fc%23d/config', undefined],
      ['PUT', '/v1/plugins/a%2Fb%3Fc%23d/config', { revision: 1 }],
      ['POST', '/v1/plugins/a%2Fb%3Fc%23d/config/reset', undefined],
    ]);
  });

  it('rejects invalid write inputs before transport and rejects malformed remote schemas and snapshots', async () => {
    const request = vi.fn(async () => ({}));
    const api = client(request);
    await expect(api.saveConfig('plugin', { revision: 0.5 })).rejects.toThrow();
    await expect(api.saveConfig('plugin', { revision: 0, secretValues: { token: 1 } } as never)).rejects.toThrow();
    await expect(api.getConfig('')).rejects.toThrow();
    await expect(api.registerConfigSchema('plugin', { ...schema, fields: [{ key: 'nested', type: 'object', label: 'Nested', children: [{ key: 'bad', type: 'unknown', label: 'Bad' }] }] } as never)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
    await expect(api.getConfigSchema('plugin')).rejects.toThrow();
    await expect(api.registerConfigSchema('plugin', schema)).rejects.toThrow();
    await expect(api.getConfig('plugin')).rejects.toThrow();
    await expect(api.saveConfig('plugin', { revision: 0 })).rejects.toThrow();
    await expect(api.resetConfig('plugin')).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('binds Page configuration reads, saves and resets to the captured lifecycle generation', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const api = client(async (method, path, body) => {
      calls.push([method, path, body]);
      return snapshot;
    });
    const generation = 'generation/a?b#c';
    await api.getConfig('a/b?c#d', generation);
    await api.saveConfig('a/b?c#d', { revision: 1, expectedLifecycleGeneration: generation });
    await api.resetConfig('a/b?c#d', generation);
    expect(calls).toEqual([
      ['GET', '/v1/plugins/a%2Fb%3Fc%23d/config?expectedLifecycleGeneration=generation%2Fa%3Fb%23c', undefined],
      ['PUT', '/v1/plugins/a%2Fb%3Fc%23d/config', { revision: 1, expectedLifecycleGeneration: generation }],
      ['POST', '/v1/plugins/a%2Fb%3Fc%23d/config/reset?expectedLifecycleGeneration=generation%2Fa%3Fb%23c', undefined],
    ]);
  });

  it.each(['', 'x'.repeat(129)])('rejects invalid Page lifecycle generations before transport: %j', async generation => {
    const request = vi.fn(async () => snapshot);
    const api = client(request);
    await expect(api.getConfig('plugin', generation)).rejects.toThrow();
    await expect(api.saveConfig('plugin', { revision: 1, expectedLifecycleGeneration: generation })).rejects.toThrow();
    await expect(api.resetConfig('plugin', generation)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
