/**
 * Aervox｜思隅 @aervox/api-client — 本地模型运行时组合式 API（CR-054）
 *
 * 封装模型下载（多任务队列）/ llama-server 生命周期 / 状态查询 / SSE 实时订阅，
 * 供 Web 与 Desktop 共用。
 */
import { getApiBase, getTransport } from './transport';

export interface LocalModelDto {
  id: string;
  fileName: string;
  sizeBytes?: number;
  url?: string;
  sha256?: string;
  status: 'downloaded' | 'downloading' | 'error';
  downloadedAt?: string;
  path: string;
  error?: string;
}

/** 下载任务（多任务队列；状态机 queued→running→done|error|cancelled|paused） */
export interface DownloadTaskDto {
  id: string;
  url: string;
  fileName: string;
  modelId: string;
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled';
  receivedBytes?: number;
  totalBytes?: number | null;
  /** 断点续传基准（.part 既有字节 / 暂停点） */
  resumableFrom?: number;
  /** 限速（bytes/sec，0 或缺省不限） */
  rateLimitBps?: number;
  error?: string;
}

/** 内置精选 GGUF 目录条目 */
export interface ModelCatalogEntryDto {
  id: string;
  name: string;
  family: string;
  quant: string;
  sizeLabel: string;
  sizeBytes?: number;
  url: string;
  sha256?: string;
  recommendedParams?: {
    port?: number;
    ctxSize?: number;
    gpuLayers?: number;
    threads?: number;
  };
}

/** llama-server 运行指标采样（非持久化） */
export interface LlamaMetricSampleDto {
  at: string;
  tokensPerSec?: number;
  promptTokensPerSec?: number;
}

export interface ModelRuntimeStateDto {
  models: LocalModelDto[];
  runtime: {
    status: 'idle' | 'starting' | 'running' | 'stopping' | 'error';
    pid?: number | null;
    port?: number;
    modelId?: string;
    binPath?: string;
    startedAt?: string;
    error?: string;
    logs?: string[];
    metrics?: LlamaMetricSampleDto[];
  };
  params?: {
    port: number;
    ctxSize: number;
    gpuLayers: number;
    threads: number;
  };
  /** 多任务下载队列（含排队与执行中任务） */
  downloads: DownloadTaskDto[];
  llamaServer: {
    configured: boolean;
    binPath?: string;
    source: 'env' | 'default' | 'missing';
    /** 下载并发上限（服务端配置） */
    maxConcurrentDownloads?: number;
  };
}

export interface ModelDownloadInput {
  url: string;
  sha256?: string;
  fileName?: string;
  /** 下载完成后自动启动 llama-server 并联动 LLM 预设 */
  autoStart?: boolean;
  /** 限速（bytes/sec，留空不限） */
  rateLimitBps?: number;
}

export interface ModelRuntimeStartInput {
  modelId: string;
  params?: Partial<NonNullable<ModelRuntimeStateDto['params']>>;
}

export function useAervoxModelRuntime() {
  const transport = getTransport();

  /** 全量状态（模型注册表 / 运行时 / 下载队列 / llama-server 配置） */
  const getState = async (): Promise<ModelRuntimeStateDto> =>
    transport.request<ModelRuntimeStateDto>('GET', '/v1/model-runtime/state');

  /** 内置精选 GGUF 目录 */
  const getCatalog = async (): Promise<ModelCatalogEntryDto[]> => {
    const res = await transport.request<{ entries: ModelCatalogEntryDto[] }>(
      'GET',
      '/v1/model-runtime/catalog',
    );
    return res.entries ?? [];
  };

  /** 发起模型下载（进入多任务队列；重名/busy 时服务端 409） */
  const download = async (input: ModelDownloadInput): Promise<ModelRuntimeStateDto> =>
    transport.request<ModelRuntimeStateDto>('POST', '/v1/model-runtime/downloads', input);

  /** 暂停下载（保留 .part，支持断点续传） */
  const pauseDownload = async (taskId: string): Promise<ModelRuntimeStateDto> =>
    transport.request<ModelRuntimeStateDto>(
      'POST',
      `/v1/model-runtime/downloads/${encodeURIComponent(taskId)}/pause`,
    );

  /** 恢复已暂停的下载（.part 续传） */
  const resumeDownload = async (taskId: string): Promise<ModelRuntimeStateDto> =>
    transport.request<ModelRuntimeStateDto>(
      'POST',
      `/v1/model-runtime/downloads/${encodeURIComponent(taskId)}/resume`,
    );

  /** 取消下载（清除 .part 残片） */
  const cancelDownload = async (taskId: string): Promise<ModelRuntimeStateDto> =>
    transport.request<ModelRuntimeStateDto>(
      'POST',
      `/v1/model-runtime/downloads/${encodeURIComponent(taskId)}/cancel`,
    );

  /** 启动 llama-server 服务指定模型 */
  const start = async (input: ModelRuntimeStartInput): Promise<ModelRuntimeStateDto> =>
    transport.request<ModelRuntimeStateDto>('POST', '/v1/model-runtime/start', input);

  /** 停止当前 llama-server（幂等） */
  const stop = async (): Promise<ModelRuntimeStateDto> =>
    transport.request<ModelRuntimeStateDto>('POST', '/v1/model-runtime/stop');

  /** 删除已下载模型（运行中禁止） */
  const deleteModel = async (modelId: string): Promise<ModelRuntimeStateDto> =>
    transport.request<ModelRuntimeStateDto>(
      'DELETE',
      `/v1/model-runtime/models/${encodeURIComponent(modelId)}`,
    );

  /**
   * 订阅运行时状态实时快照（GET /v1/model-runtime/events）。
   * 基于 fetch 流式读取，Web/Desktop 同源走直连；失败由调用方回退轮询 state。
   * 返回退订函数。
   */
  const subscribeState = (
    onSnapshot: (state: ModelRuntimeStateDto) => void,
    onError?: (err: unknown) => void,
  ): (() => void) => {
    const controller = new AbortController();
    void (async () => {
      try {
        const res = await fetch(`${getApiBase()}/v1/model-runtime/events`, {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`SSE 连接失败 HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() ?? '';
          for (const block of blocks) {
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('data:')) data += line.slice(5).trim();
            }
            if (!data) continue;
            try {
              const payload = JSON.parse(data) as { event?: string; data?: ModelRuntimeStateDto };
              if (payload.event === 'snapshot' && payload.data) onSnapshot(payload.data);
            } catch {
              // 忽略坏帧
            }
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        onError?.(err);
      }
    })();
    return () => controller.abort();
  };

  return {
    getState,
    getCatalog,
    download,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    start,
    stop,
    deleteModel,
    subscribeState,
  };
}
