/**
 * Aervox｜思隅 @aervox/api-client — 本地模型运行时组合式 API（CR-054）
 *
 * 封装模型下载（多任务队列）/ llama-server 生命周期 / 状态查询 / SSE 实时订阅，
 * 供 Web 与 Desktop 共用。
 */
import { getTransport } from './transport';
import { modelRuntimeApi } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';

// Preserve public client names while deriving every DTO from the shared schemas.
export type {
  LocalModel as LocalModelDto,
  DownloadTask as DownloadTaskDto,
  ModelCatalogEntry as ModelCatalogEntryDto,
  LlamaMetricSample as LlamaMetricSampleDto,
  ModelRuntimeState as ModelRuntimeStateDto,
  ModelDownloadRequestInput as ModelDownloadInput,
  ModelRuntimeStartRequest as ModelRuntimeStartInput,
} from '@aervox/contracts';
import type {
  ModelCatalogEntry as ModelCatalogEntryDto,
  ModelRuntimeState as ModelRuntimeStateDto,
  ModelDownloadRequestInput as ModelDownloadInput,
  ModelRuntimeStartRequest as ModelRuntimeStartInput,
} from '@aervox/contracts';

export function useAervoxModelRuntime() {
  const transport = getTransport();

  /** 全量状态（模型注册表 / 运行时 / 下载队列 / llama-server 配置） */
  const getState = async (): Promise<ModelRuntimeStateDto> =>
    requestEndpoint(transport, modelRuntimeApi.state);

  /** 内置精选 GGUF 目录 */
  const getCatalog = async (): Promise<ModelCatalogEntryDto[]> => {
    const res = await requestEndpoint(transport, modelRuntimeApi.catalog);
    return res.entries;
  };

  /** 发起模型下载（进入多任务队列；重名/busy 时服务端 409） */
  const download = async (input: ModelDownloadInput): Promise<ModelRuntimeStateDto> =>
    requestEndpoint(transport, modelRuntimeApi.download, input);

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
   * 由注入的 Transport 负责平台通道和认证；不支持订阅时由调用方回退轮询 state。
   * 返回退订函数。
   */
  const subscribeState = (
    onSnapshot: (state: ModelRuntimeStateDto) => void,
    onError?: (err: unknown) => void,
  ): (() => void) => {
    const controller = new AbortController();
    void (async () => {
      try {
        if (!transport.streamEvents) throw new Error('event_stream_unavailable');
        await transport.streamEvents('/v1/model-runtime/events', {
          onEvent(value) {
            if (!value || typeof value !== 'object') return;
            const payload = value as { event?: string; data?: ModelRuntimeStateDto };
            if (payload.event === 'snapshot' && payload.data) onSnapshot(payload.data);
          },
        }, controller.signal);
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
