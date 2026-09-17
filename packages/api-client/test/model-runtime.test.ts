import { describe, expect, it } from 'vitest';
import { configureAervoxClient, type AervoxTransport } from '../src/transport';
import { useAervoxModelRuntime } from '../src/useAervoxModelRuntime';

describe('useAervoxModelRuntime (CR-054 v2)', () => {
  function makeTransport(handler: (method: string, path: string, body?: unknown) => Promise<unknown>): AervoxTransport {
    return { request: async <T>(method: string, path: string, body?: unknown): Promise<T> => handler(method, path, body) as Promise<T> };
  }

  it('状态 / 目录 / 下载 / 暂停 / 恢复 / 取消 / 启动 / 停止 映射到正确端点', async () => {
    const calls: Array<[string, string, unknown]> = [];
    configureAervoxClient({ transport: makeTransport(async (m, p, b) => {
      calls.push([m, p, b]);
      return {};
    }) });

    const api = useAervoxModelRuntime();
    await api.getState();
    await api.getCatalog();
    await api.download({ url: 'https://example.com/m.gguf', sha256: 'ab', rateLimitBps: 1024 });
    await api.pauseDownload('m');
    await api.resumeDownload('m');
    await api.cancelDownload('m');
    await api.start({ modelId: 'm', params: { port: 8080 } });
    await api.stop();
    await api.deleteModel('qwen-del');

    expect(calls.map(([m, p]) => `${m} ${p}`)).toEqual([
      'GET /v1/model-runtime/state',
      'GET /v1/model-runtime/catalog',
      'POST /v1/model-runtime/downloads',
      'POST /v1/model-runtime/downloads/m/pause',
      'POST /v1/model-runtime/downloads/m/resume',
      'POST /v1/model-runtime/downloads/m/cancel',
      'POST /v1/model-runtime/start',
      'POST /v1/model-runtime/stop',
      'DELETE /v1/model-runtime/models/qwen-del',
    ]);
    // 下载/启动 body 原样透传（Electron IPC 结构化克隆边界）
    expect(calls[2][2]).toEqual({ url: 'https://example.com/m.gguf', sha256: 'ab', rateLimitBps: 1024 });
    expect(calls[6][2]).toEqual({ modelId: 'm', params: { port: 8080 } });
  });

  it('catalog 返回 entries 数组', async () => {
    configureAervoxClient({
      transport: makeTransport(async () => ({
        entries: [{ id: 'qwen', name: 'Qwen', family: 'Qwen2.5', quant: 'Q4_K_M', sizeLabel: '~4.7 GB', url: 'https://example.com/q.gguf' }],
      })),
    });
    const api = useAervoxModelRuntime();
    const entries = await api.getCatalog();
    expect(entries).toHaveLength(1);
    expect(entries[0].quant).toBe('Q4_K_M');
  });

  it('返回的 DTO 包含运行时日志、指标与多任务下载队列', async () => {
    configureAervoxClient({
      transport: makeTransport(async () => ({
        models: [{ id: 'm', fileName: 'm.gguf', path: '/x/m.gguf', status: 'downloaded' }],
        runtime: { status: 'running', port: 8080, logs: ['boot ok'], metrics: [{ at: '2026-01-01T00:00:00Z', tokensPerSec: 42 }] },
        downloads: [{ id: 'm', url: 'https://example.com/m.gguf', fileName: 'm.gguf', modelId: 'm', status: 'running', receivedBytes: 1234, resumableFrom: 1000 }],
        llamaServer: { source: 'missing', maxConcurrentDownloads: 2 },
      })),
    });

    const api = useAervoxModelRuntime();
    const state = await api.getState();
    expect(state.models[0].fileName).toBe('m.gguf');
    expect(state.runtime.status).toBe('running');
    expect(state.runtime.logs).toContain('boot ok');
    expect(state.runtime.metrics?.[0].tokensPerSec).toBe(42);
    expect(state.downloads[0].status).toBe('running');
    expect(state.downloads[0].receivedBytes).toBe(1234);
    expect(state.llamaServer.maxConcurrentDownloads).toBe(2);
  });
});
