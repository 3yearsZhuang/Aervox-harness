import { describe, expect, it } from 'vitest';
import { configureAervoxClient, type AervoxTransport } from '../src/transport';
import { useAervoxModelRuntime } from '../src/useAervoxModelRuntime';

describe('useAervoxModelRuntime (CR-054)', () => {
  function makeTransport(handler: (method: string, path: string, body?: unknown) => Promise<unknown>): AervoxTransport {
    return { request: async <T>(method: string, path: string, body?: unknown): Promise<T> => handler(method, path, body) as Promise<T> };
  }

  it('状态查询 / 下载 / 取消 / 启动 / 停止 映射到正确端点', async () => {
    const calls: Array<[string, string, unknown]> = [];
    configureAervoxClient({ transport: makeTransport(async (m, p, b) => {
      calls.push([m, p, b]);
      return {};
    }) });

    const api = useAervoxModelRuntime();
    await api.getState();
    await api.download({ url: 'https://example.com/m.gguf', sha256: 'ab' });
    await api.cancelDownload();
    await api.start({ modelId: 'm', params: { port: 8080 } });
    await api.stop();

    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual([
      'GET /v1/model-runtime/state',
      'POST /v1/model-runtime/downloads',
      'POST /v1/model-runtime/downloads/cancel',
      'POST /v1/model-runtime/start',
      'POST /v1/model-runtime/stop',
    ]);
    // 下载/启动 body 原样透传（Electron IPC 结构化克隆边界）
    expect(calls[1][2]).toEqual({ url: 'https://example.com/m.gguf', sha256: 'ab' });
    expect(calls[3][2]).toEqual({ modelId: 'm', params: { port: 8080 } });
  });

  it('返回的 DTO 包含运行时与下载进度字段', async () => {
    configureAervoxClient({
      transport: makeTransport(async () => ({
        models: [{ id: 'm', fileName: 'm.gguf', path: '/x/m.gguf', status: 'downloaded' }],
        runtime: { status: 'running', port: 8080 },
        download: { active: false },
        llamaServer: { source: 'missing' },
      })),
    });

    const api = useAervoxModelRuntime();
    const state = await api.getState();
    expect(state.models[0].fileName).toBe('m.gguf');
    expect(state.runtime.status).toBe('running');
  });
});