import { describe, expect, it } from 'vitest';
import { configureAervoxClient, type AervoxTransport } from '../src/transport';
import { useAervoxPlugins } from '../src/useAervoxPlugins';

describe('plugin user data management client', () => {
  it('uses the shared export and uninstall endpoints without activating the plugin', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const data = { format: 'aervox-plugin-data/v1', pluginId: 'missing-owner', revision: 2, schemaVersion: 1, values: { note: 'persisted' } };
    const transport: AervoxTransport = {
      async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        calls.push({ method, path, body });
        return (path.endsWith('/data-export') ? data : method === 'DELETE' ? undefined : { items: [] }) as T;
      },
      streamTurn: async () => undefined,
      submitQuestionAnswers: async () => undefined,
    };
    configureAervoxClient({ transport });
    const api = useAervoxPlugins();
    expect(await api.exportData('missing-owner')).toEqual(data);
    await api.uninstallPlugin('missing-owner');
    expect(calls).toEqual([
      { method: 'GET', path: '/v1/plugins/missing-owner/data-export', body: undefined },
      { method: 'DELETE', path: '/v1/plugins/missing-owner', body: undefined },
      { method: 'GET', path: '/v1/plugins', body: undefined },
    ]);
  });
});
