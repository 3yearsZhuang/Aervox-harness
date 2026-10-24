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
  it.each(['getConfig', 'resetConfig'] as const)('encodes the complete captured Page identity for %s', async operation => {
    const request = vi.fn(async () => snapshot);
    const api = client(request);
    await api[operation]('a/b?c#d', {
      expectedLifecycleGeneration: 'generation/a?b#c', expectedPageId: 'settings', expectedPageGeneration: 'page/a?b#c',
    });
    const path = operation === 'getConfig' ? '/config' : '/config/reset';
    expect(request).toHaveBeenCalledWith(operation === 'getConfig' ? 'GET' : 'POST',
      `/v1/plugins/a%2Fb%3Fc%23d${path}?expectedLifecycleGeneration=generation%2Fa%3Fb%23c&expectedPageId=settings&expectedPageGeneration=page%2Fa%3Fb%23c`, undefined);
  });

  it.each(['getConfig', 'resetConfig'] as const)('keeps empty and lifecycle-only management query objects valid for %s', async operation => {
    const request = vi.fn(async () => snapshot);
    const api = client(request);
    await api[operation]('plugin', {});
    await api[operation]('plugin', { expectedLifecycleGeneration: 'generation' });
    const path = `/v1/plugins/plugin${operation === 'getConfig' ? '/config' : '/config/reset'}`;
    expect(request.mock.calls).toEqual([
      [operation === 'getConfig' ? 'GET' : 'POST', path, undefined],
      [operation === 'getConfig' ? 'GET' : 'POST', `${path}?expectedLifecycleGeneration=generation`, undefined],
    ]);
  });

  it.each(['getConfig', 'resetConfig'] as const)('rejects malformed or incomplete %s identity before transport', async operation => {
    const request = vi.fn(async () => snapshot);
    const api = client(request);
    const identity = { expectedPageId: 'settings', expectedPageGeneration: 'page-generation', expectedLifecycleGeneration: 'generation' };
    const inputs: unknown[] = [
      null, 7, [],
      { expectedPageId: 'settings', expectedLifecycleGeneration: 'generation' },
      { expectedPageGeneration: 'page-generation', expectedLifecycleGeneration: 'generation' },
      { expectedPageId: 'settings', expectedPageGeneration: 'page-generation' },
      ...[null, '', '../settings', 'settings/other', 'x'.repeat(65), 7, [], {}].map(expectedPageId => ({ ...identity, expectedPageId })),
      ...[null, '', 'x'.repeat(129), 7, [], {}].flatMap(value => [
        { ...identity, expectedPageGeneration: value }, { ...identity, expectedLifecycleGeneration: value },
      ]),
    ];
    for (const input of inputs) {
      await expect(api[operation]('plugin', input as never), JSON.stringify(input)).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('validates Page grants, preserves nullable metadata and encodes the lifecycle query', async () => {
    const request = vi.fn(async () => ({ pages: [{ id: 'settings', title: 'Settings', entry: 'pages/settings/index.html',
      description: null, checksum: null, capabilities: ['host.notify'], pageGeneration: 'page-generation' }] }));
    const api = client(request);
    expect(await api.listPages('a/b?c#d', 'generation/a?b#c')).toEqual([{ id: 'settings', title: 'Settings',
      entry: 'pages/settings/index.html', description: null, checksum: null, capabilities: ['host.notify'], pageGeneration: 'page-generation' }]);
    expect(request).toHaveBeenLastCalledWith('GET', '/v1/plugins/a%2Fb%3Fc%23d/pages?expectedLifecycleGeneration=generation%2Fa%3Fb%23c', undefined);
    request.mockResolvedValue({ pages: [{ id: 'settings', title: 'Settings', entry: 'pages/settings/index.html',
      capabilities: ['unknown-grant'], pageGeneration: 'page-generation' }] } as never);
    await expect(api.listPages('plugin', 'generation')).rejects.toThrow();
    request.mockClear();
    await expect(api.listPages('plugin', '')).rejects.toThrow();
    await expect(api.listPages('plugin', 'x'.repeat(129))).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([[undefined], [null], [''], ['x'.repeat(129)], [7], [[]], [{}]])('rejects a Page response with malformed generation %j', async pageGeneration => {
    const request = vi.fn(async () => ({ pages: [{ id: 'settings', title: 'Settings', entry: 'pages/settings/index.html',
      capabilities: ['config.read'], pageGeneration }] }));
    await expect(client(request).listPages('plugin', 'generation')).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
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

  it('preserves the Page write identity in the shared save payload', async () => {
    const request = vi.fn(async () => snapshot);
    const api = client(request);
    await api.saveConfig('plugin', {
      revision: 1, expectedPageId: 'settings', expectedPageGeneration: 'page-generation', expectedLifecycleGeneration: 'generation',
    });
    expect(request).toHaveBeenCalledWith('PUT', '/v1/plugins/plugin/config', {
      revision: 1, expectedPageId: 'settings', expectedPageGeneration: 'page-generation', expectedLifecycleGeneration: 'generation',
    });
  });

  it.each(['', '../settings', 'settings/other', 'x'.repeat(65), null])('rejects an invalid Page write identity before transport: %j', async expectedPageId => {
    const request = vi.fn(async () => snapshot);
    const api = client(request);
    await expect(api.saveConfig('plugin', {
      revision: 1, expectedPageId, expectedPageGeneration: 'page-generation', expectedLifecycleGeneration: 'generation',
    } as never)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects a Page write identity without an explicit lifecycle generation before transport', async () => {
    const request = vi.fn(async () => snapshot);
    const api = client(request);
    await expect(api.saveConfig('plugin', { revision: 1, expectedPageId: 'settings', expectedPageGeneration: 'page-generation' })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    { expectedPageId: 'settings', expectedLifecycleGeneration: 'generation' },
    { expectedPageGeneration: 'page-generation', expectedLifecycleGeneration: 'generation' },
  ])('rejects half of the Page identity before transport: %j', async incomplete => {
    const request = vi.fn(async () => snapshot);
    const api = client(request);
    await expect(api.saveConfig('plugin', { revision: 1, ...incomplete })).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it.each([[null], [''], ['x'.repeat(129)], [7], [[]], [{}]])('rejects an invalid Page write generation before transport: %j', async expectedPageGeneration => {
    const request = vi.fn(async () => snapshot);
    const api = client(request);
    await expect(api.saveConfig('plugin', {
      revision: 1, expectedPageId: 'settings', expectedLifecycleGeneration: 'generation', expectedPageGeneration,
    } as never)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
});
