import { describe, expect, it, vi } from 'vitest';
import { PLUGIN_SENSOR_PERMISSION, pluginsApi } from '@aervox/contracts';
import { configureAervoxClient, type AervoxTransport } from '../src/transport.js';
import { useAervoxPlugins } from '../src/useAervoxPlugins.js';
import { requestEndpoint } from '../src/endpoint.js';

const plugin = { id: 'a/b?c#d', publisher: 'fixture', version: '1', checksum: 'fixture', installSource: 'registry',
  enabled: 1, availability: 'available', lifecycleGeneration: 'generation', signature: null, bundleGeneration: null,
  displayName: null, configSchemaJson: null, createdAt: 'created', updatedAt: 'updated' };
const grant = { id: 'grant/a?b', pluginId: plugin.id, permission: PLUGIN_SENSOR_PERMISSION, scope: 'system/window?x',
  grantedAt: 'granted', revokedAt: null, createdAt: 'created', updatedAt: 'updated' };
function connection(handler: (method: string, path: string, body?: unknown) => Promise<unknown>) {
  const transport: AervoxTransport = { request: async <T>(method: string, path: string, body?: unknown) => handler(method, path, body) as Promise<T> };
  configureAervoxClient({ transport });
  return { api: useAervoxPlugins(), transport };
}

describe('plugin management shared client contracts', () => {
  it('validates the list while preserving nullable and extension metadata', async () => {
    const handler = vi.fn(async () => ({ items: [plugin] }));
    const { api } = connection(handler);
    await api.loadPlugins();
    expect(api.plugins.value).toEqual([plugin]);
    expect(api.error.value).toBeNull();
    handler.mockResolvedValue({ items: [{ ...plugin, enabled: true }] } as never);
    await api.loadPlugins();
    expect(api.error.value).toBeTruthy();
    expect(api.plugins.value).toEqual([plugin]);
    expect(api.loading.value).toBe(false);
  });

  it('encodes plugin ids, validates the PATCH row and preserves the void return', async () => {
    const handler = vi.fn(async () => ({ ...plugin, enabled: 0 }));
    const { api } = connection(handler);
    expect(await api.setPluginEnabled(plugin.id, false)).toBeUndefined();
    expect(handler).toHaveBeenCalledExactlyOnceWith('PATCH', '/v1/plugins/a%2Fb%3Fc%23d', { enabled: false });
    handler.mockResolvedValue({ id: plugin.id } as never);
    await expect(api.setPluginEnabled(plugin.id, true)).rejects.toThrow();
  });

  it('uses the shared grant, list and revoke descriptors without converting revoke into 204', async () => {
    const handler = vi.fn(async (method: string) => method === 'GET' ? { items: [grant] } : grant);
    const { api } = connection(handler);
    expect(await api.grantSensor(plugin.id, grant.scope)).toEqual(grant);
    expect(handler).toHaveBeenLastCalledWith('POST', '/v1/plugins/a%2Fb%3Fc%23d/grants', { permission: PLUGIN_SENSOR_PERMISSION, scope: grant.scope });
    expect(await api.listSensorGrants(plugin.id)).toEqual([grant]);
    expect(handler).toHaveBeenLastCalledWith('GET', '/v1/plugins/a%2Fb%3Fc%23d/grants', undefined);
    expect(await api.revokeSensorGrant(plugin.id, grant.id)).toBeUndefined();
    expect(handler).toHaveBeenLastCalledWith('DELETE', '/v1/plugins/a%2Fb%3Fc%23d/grants/grant%2Fa%3Fb', undefined);
  });

  it('keeps permission scope out of the path and rejects truthy non-boolean responses', async () => {
    const handler = vi.fn(async () => ({ pluginId: plugin.id, permission: PLUGIN_SENSOR_PERMISSION, scope: grant.scope, granted: true }));
    const { api } = connection(handler);
    expect(await api.hasSensorGrant(plugin.id, grant.scope)).toBe(true);
    expect(handler).toHaveBeenCalledExactlyOnceWith('GET', `/v1/plugins/a%2Fb%3Fc%23d/permissions/${PLUGIN_SENSOR_PERMISSION}?scope=system%2Fwindow%3Fx`, undefined);
    handler.mockResolvedValue({ pluginId: plugin.id, permission: PLUGIN_SENSOR_PERMISSION, scope: grant.scope, granted: 'yes' } as never);
    await expect(api.hasSensorGrant(plugin.id, grant.scope)).rejects.toThrow();
  });

  it('rejects invalid inputs before transport', async () => {
    const handler = vi.fn(async () => grant);
    const { api } = connection(handler);
    await expect(api.setPluginEnabled('', true)).rejects.toThrow();
    await expect(api.setPluginEnabled(plugin.id, 'true' as never)).rejects.toThrow();
    await expect(api.grantSensor(plugin.id, '')).rejects.toThrow();
    await expect(api.listSensorGrants('')).rejects.toThrow();
    await expect(api.revokeSensorGrant(plugin.id, '')).rejects.toThrow();
    await expect(api.hasSensorGrant('', 'source')).rejects.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['grant', 'list', 'revoke'] as const)('rejects a malformed %s response rather than synthesizing success', async method => {
    const { api } = connection(async () => method === 'list' ? { items: [{}] } : undefined);
    await expect(method === 'grant' ? api.grantSensor(plugin.id, 'source')
      : method === 'list' ? api.listSensorGrants(plugin.id) : api.revokeSensorGrant(plugin.id, 'grant')).rejects.toThrow();
  });

  it('preserves the shared empty plugin deletion response', async () => {
    const handler = vi.fn(async () => undefined);
    const { transport } = connection(handler);
    expect(await requestEndpoint(transport, pluginsApi.delete, undefined, { pluginId: plugin.id })).toBeUndefined();
    expect(handler).toHaveBeenCalledExactlyOnceWith('DELETE', '/v1/plugins/a%2Fb%3Fc%23d', undefined);
  });
});
