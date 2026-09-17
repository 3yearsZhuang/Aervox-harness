/**
 * @aervox/api-client — useAervoxPlugins 分发扩展端点测试（CAP-020 插件分发）
 *
 * 覆盖：
 * - inspectPackage (POST /v1/plugins/inspect-package)
 * - installPackage (POST /v1/plugins/install-package)
 * - exportPackage (GET /v1/plugins/:id/export)
 * - listMarket (GET /v1/plugins/market)
 * - installFromMarket (POST /v1/plugins/market/:id/install)
 */
import { describe, expect, it } from 'vitest';
import { configureAervoxClient, type AervoxTransport } from '../src/transport';
import { useAervoxPlugins } from '../src/useAervoxPlugins';

describe('useAervoxPlugins distribution methods', () => {
  it('inspectPackage 透传 packageBase64 并返回预检报告', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport: AervoxTransport = {
      request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        calls.push({ method, path, body });
        return {
          id: 'test-plugin',
          displayName: '测试插件',
          publisher: 'tester',
          version: '1.0.0',
          checksum: 'abc123hash',
          isValid: true,
          tools: [],
          skills: [],
          pages: [],
          permissions: [],
          dataScope: [],
          proactive: { sensors: [], triggers: [] },
          hasConfig: false,
          alreadyInstalled: false,
          installedVersion: null,
          issues: [],
        } as T;
      },
      streamTurn: async () => undefined,
      submitQuestionAnswers: async () => undefined,
    };
    configureAervoxClient({ transport });

    const api = useAervoxPlugins();
    const inspection = await api.inspectPackage('ZHVtbXktYmFzZTY0');

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/v1/plugins/inspect-package');
    expect(calls[0]?.body).toEqual({ packageBase64: 'ZHVtbXktYmFzZTY0' });
    expect(inspection.id).toBe('test-plugin');
    expect(inspection.isValid).toBe(true);
  });

  it('installPackage 透传 packageBase64 与 overwrite，并触发刷新列表', async () => {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const transport: AervoxTransport = {
      request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        calls.push({ method, path, body });
        if (method === 'POST') {
          return {
            id: 'test-plugin',
            publisher: 'tester',
            version: '1.0.0',
            enabled: 1,
            installSource: 'package',
          } as T;
        }
        return { items: [{ id: 'test-plugin', enabled: 1 }] } as T;
      },
      streamTurn: async () => undefined,
      submitQuestionAnswers: async () => undefined,
    };
    configureAervoxClient({ transport });

    const api = useAervoxPlugins();
    const installed = await api.installPackage('ZHVtbXktYmFzZTY0', true);

    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall?.path).toBe('/v1/plugins/install-package');
    expect(postCall?.body).toEqual({ packageBase64: 'ZHVtbXktYmFzZTY0', overwrite: true });
    expect(installed.id).toBe('test-plugin');
    expect(api.plugins.value.length).toBe(1);
  });

  it('exportPackage 请求 GET /v1/plugins/:id/export', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const transport: AervoxTransport = {
      request: async <T>(method: string, path: string): Promise<T> => {
        calls.push({ method, path });
        return {
          pluginId: 'health-guard',
          filename: 'health-guard-1.0.0.aervox-plugin',
          packageBase64: 'UEtHREFUQ...',
          checksum: 'hash123',
        } as T;
      },
      streamTurn: async () => undefined,
      submitQuestionAnswers: async () => undefined,
    };
    configureAervoxClient({ transport });

    const api = useAervoxPlugins();
    const res = await api.exportPackage('health-guard');

    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('/v1/plugins/health-guard/export');
    expect(res.filename).toBe('health-guard-1.0.0.aervox-plugin');
  });

  it('listMarket 与 installFromMarket 正确调用集市端点', async () => {
    const calls: Array<{ method: string; path: string }> = [];
    const transport: AervoxTransport = {
      request: async <T>(method: string, path: string): Promise<T> => {
        calls.push({ method, path });
        if (path === '/v1/plugins/market') {
          return {
            items: [
              {
                id: 'focus-mode',
                displayName: '专注模式',
                version: '1.0.0',
                installed: false,
                capabilities: { hasConfig: true, toolsCount: 0, skillsCount: 1, sensorsCount: 0, triggersCount: 0, pagesCount: 0 },
              },
            ],
          } as T;
        }
        return { id: 'focus-mode', enabled: 1 } as T;
      },
      streamTurn: async () => undefined,
      submitQuestionAnswers: async () => undefined,
    };
    configureAervoxClient({ transport });

    const api = useAervoxPlugins();
    const market = await api.listMarket();
    expect(market.length).toBe(1);
    expect(market[0]?.id).toBe('focus-mode');

    const installed = await api.installFromMarket('focus-mode');
    expect(installed.id).toBe('focus-mode');
  });
});
