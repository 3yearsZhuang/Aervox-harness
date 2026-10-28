// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureAervoxClient, type AervoxTransport } from '../src/transport';
import { useAervoxPlugins } from '../src/useAervoxPlugins';

describe('plugin user data management client', () => {
  afterEach(() => { vi.restoreAllMocks(); document.body.innerHTML = ''; });
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

  it.each([false, true])('releases its data download URL and anchor (click fails=%s)', async fails => {
    const data = { format: 'aervox-plugin-data/v1', pluginId: 'missing-owner', revision: 2, schemaVersion: 1, values: { note: 'persisted' } };
    const transport: AervoxTransport = {
      request: async <T>() => data as T,
      streamTurn: async () => undefined,
      submitQuestionAnswers: async () => undefined,
    };
    configureAervoxClient({ transport });
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:export-data');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      expect(this.download).toBe('missing-owner-data.json');
      expect(this.isConnected).toBe(true);
      if (fails) throw new Error('download unavailable');
    });
    const pending = useAervoxPlugins().downloadData('missing-owner');
    if (fails) await expect(pending).rejects.toThrow('download unavailable');
    else await pending;
    expect(click).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await (create.mock.calls[0]![0] as Blob).text())).toEqual(data);
    expect(revoke).toHaveBeenCalledWith('blob:export-data');
    expect(document.querySelector('a')).toBeNull();
  });
});
