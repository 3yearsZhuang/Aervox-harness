/**
 * Aervox｜思隅 @aervox/api-client — 本地模型运行时组合式 API（CR-054）
 *
 * 封装模型下载 / llama-server 生命周期 / 状态查询，供 Web 与 Desktop 共用。
 */
import { getTransport } from './transport';

export interface LocalModelDto {
  id: string;
  fileName: string;
  sizeBytes?: number;
  url?: string;
  sha256?: string;
  status: 'downloaded' | 'downloading' | 'error';
  downloadedAt?: string;
  path: string;
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
  };
  params?: {
    port: number;
    ctxSize: number;
    gpuLayers: number;
    threads: number;
  };
  download: {
    active: boolean;
    url?: string;
    modelId?: string;
    receivedBytes?: number;
    totalBytes?: number | null;
    status?: 'running' | 'done' | 'error' | 'cancelled';
    error?: string;
  };
  llamaServer: {
    configured: boolean;
    binPath?: string;
    source: 'env' | 'default' | 'missing';
  };
}

export interface ModelDownloadInput {
  url: string;
  sha256?: string;
  fileName?: string;
}

export interface ModelRuntimeStartInput {
  modelId: string;
  params?: Partial<NonNullable<ModelRuntimeStateDto['params']>>;
}

export function useAervoxModelRuntime() {
  const transport = getTransport();

  /** 全量状态（模型注册表 / 运行时 / 下载进度 / llama-server 配置） */
  const getState = async (): Promise<ModelRuntimeStateDto> =>
    transport.request<ModelRuntimeStateDto>('GET', '/v1/model-runtime/state');

  /** 发起模型下载（单任务队列；busy 时服务端 409） */
  const download = async (input: ModelDownloadInput): Promise<ModelRuntimeStateDto> =>
    transport.request<ModelRuntimeStateDto>('POST', '/v1/model-runtime/downloads', input);

  /** 取消进行中的下载 */
  const cancelDownload = async (): Promise<ModelRuntimeStateDto> =>
    transport.request<ModelRuntimeStateDto>('POST', '/v1/model-runtime/downloads/cancel');

  /** 启动 llama-server 服务指定模型 */
  const start = async (input: ModelRuntimeStartInput): Promise<ModelRuntimeStateDto> =>
    transport.request<ModelRuntimeStateDto>('POST', '/v1/model-runtime/start', input);

  /** 停止当前 llama-server（幂等） */
  const stop = async (): Promise<ModelRuntimeStateDto> =>
    transport.request<ModelRuntimeStateDto>('POST', '/v1/model-runtime/stop');

  return { getState, download, cancelDownload, start, stop };
}