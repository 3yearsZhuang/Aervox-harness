/**
 * @aervox/api-client — useAervoxPlugins.installPlugin 客户端测试（CAP-020 扩展中心）
 *
 * 覆盖：POST /v1/plugins 载荷透传（含 installSource）与安装后列表自动刷新。
 */
import {describe, expect, it} from 'vitest';
import {configureAervoxClient, type AervoxTransport} from '../src/transport';
import {useAervoxPlugins} from '../src/useAervoxPlugins';

describe('useAervoxPlugins.installPlugin', () => {
  it('POST /v1/plugins 透传安装载荷，成功后自动刷新插件列表', async () => {
    const calls: Array<{method: string; path: string; body?: unknown}> = [];
    const transport: AervoxTransport = {
      request: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
        calls.push({method, path, body});
        if (method === 'POST') {
          return {
            id: 'com.example.notes',
            publisher: 'aervox-official',
            version: '0.1.0',
            installSource: 'manual',
            enabled: 1,
          } as T;
        }
        return {
          items: [
            {
              id: 'com.example.notes',
              publisher: 'aervox-official',
              version: '0.1.0',
              installSource: 'manual',
              enabled: 1,
            },
          ],
        } as T;
      },
      streamTurn: async () => undefined,
      submitQuestionAnswers: async () => undefined,
    };
    configureAervoxClient({transport});

    const api = useAervoxPlugins();
    const created = await api.installPlugin({
      id: 'com.example.notes',
      publisher: 'aervox-official',
      version: '0.1.0',
      installSource: 'manual',
      permissions: ['fs.read'],
      tools: [{name: 'search_notes', category: 'search', safetyLevel: 'read_only'}],
      skills: [{name: 'note-taking', content: '…'}],
    });

    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe('/v1/plugins');
    expect(post?.body).toMatchObject({
      id: 'com.example.notes',
      installSource: 'manual',
      permissions: ['fs.read'],
    });
    expect(created.id).toBe('com.example.notes');
    // 安装后自动刷新：列表可观察
    expect(api.plugins.value.map((p) => p.id)).toEqual(['com.example.notes']);
  });
});
