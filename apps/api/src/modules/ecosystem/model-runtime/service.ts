/**
 * Aervox｜思隅 @aervox/api — 本地模型运行时编排服务（CR-054）
 *
 * v2（CR-054 迭代）：
 * - 多任务下载队列（并发上限可配，缺省 2）：queued→running→done|error|cancelled|paused，
 *   暂停保留 .part 支持断点续传，取消删除残片；
 * - 限速（rateLimitBps，bytes/sec）；
 * - 运行指标采样（llama.cpp /metrics tokens/s）随 state 曝光；
 * - 内置精选 GGUF 目录（catalog）+ 任意 URL 入口并存；
 * - SSE 实时订阅（GET /v1/model-runtime/events）推送状态快照，前端断线回退轮询。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type {
  DownloadTask,
  LlamaMetricSample,
  LlamaRuntimeParams,
  LocalModel,
  ModelCatalogEntry,
  ModelDownloadRequest,
  ModelRuntimeStartRequest,
  ModelRuntimeState,
} from "@aervox/contracts";
import { downloadToFile, ModelDownloadError } from "./downloader.js";
import { LlamaServerManager, type LlamaServerManagerDeps } from "./llama-server.js";

export interface ModelRuntimeServiceOptions {
  /** 模型落盘目录（缺省 <repo>/data/models） */
  modelsDir?: string;
  /** 下载并发上限（缺省 2） */
  maxConcurrentDownloads?: number;
  /** 指标采样间隔 ms（缺省 2000；0 关闭） */
  metricsIntervalMs?: number;
  llamaDeps?: LlamaServerManagerDeps;
}

interface TaskState extends DownloadTask {
  controller?: AbortController;
  partPath?: string;
  /** 期望校验值（用户提供时强校验） */
  expectedSha256?: string;
  /** 完成后自动启动并联动预设 */
  autoStart?: boolean;
}

const DEFAULT_PARAMS: LlamaRuntimeParams = {
  port: 8080,
  ctxSize: 8192,
  gpuLayers: 99,
  threads: 4,
};

/** 内置精选 GGUF 目录（官方/社区公开仓库；sha256 留空表示可选校验，下载后以 content-length 刷新尺寸） */
const DEFAULT_CATALOG: ModelCatalogEntry[] = [
  {
    id: "qwen2.5-7b-instruct-q4-k-m",
    name: "Qwen2.5 7B Instruct",
    family: "Qwen2.5",
    quant: "Q4_K_M",
    sizeLabel: "~4.7 GB",
    url: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf",
    recommendedParams: { ctxSize: 8192, gpuLayers: 99, threads: 4 },
  },
  {
    id: "qwen2.5-7b-instruct-q8-0",
    name: "Qwen2.5 7B Instruct",
    family: "Qwen2.5",
    quant: "Q8_0",
    sizeLabel: "~8.2 GB",
    url: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q8_0.gguf",
    recommendedParams: { ctxSize: 8192, gpuLayers: 99, threads: 4 },
  },
  {
    id: "llama-3.1-8b-instruct-q4-k-m",
    name: "Llama 3.1 8B Instruct",
    family: "Llama",
    quant: "Q4_K_M",
    sizeLabel: "~4.9 GB",
    url: "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf",
    recommendedParams: { ctxSize: 8192, gpuLayers: 99, threads: 4 },
  },
  {
    id: "qwen3-4b-instruct-q4-k-m",
    name: "Qwen3 4B Instruct",
    family: "Qwen3",
    quant: "Q4_K_M",
    sizeLabel: "~2.8 GB",
    url: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/qwen3-4b-instruct-q4_k_m.gguf",
    recommendedParams: { ctxSize: 8192, gpuLayers: 99, threads: 4 },
  },
];

export class ModelRuntimeService {
  private readonly modelsDir: string;
  private readonly llama: LlamaServerManager;
  private readonly maxConcurrentDownloads: number;
  private readonly catalog: ModelCatalogEntry[];
  private lastParams: LlamaRuntimeParams = { ...DEFAULT_PARAMS };
  private readonly tasks = new Map<string, TaskState>();
  private readonly queue: string[] = [];
  private runningCount = 0;
  private readonly subscribers = new Set<(state: ModelRuntimeState) => void>();
  private readonly metricSamples: LlamaMetricSample[] = [];
  private metricsTimer: ReturnType<typeof setInterval> | null = null;
  private lastEmitAt = 0;

  constructor(options: ModelRuntimeServiceOptions = {}) {
    this.modelsDir = options.modelsDir ?? path.join(process.cwd(), "data", "models");
    this.maxConcurrentDownloads = options.maxConcurrentDownloads ?? 2;
    this.catalog = DEFAULT_CATALOG;
    this.llama = new LlamaServerManager(options.llamaDeps);
    const metricsInterval = options.metricsIntervalMs ?? 2000;
    if (metricsInterval > 0) {
      this.metricsTimer = setInterval(() => {
        void this.sampleMetrics();
      }, metricsInterval);
      this.metricsTimer.unref?.();
    }
  }

  private sidecarPath(modelPath: string): string {
    return modelPath.replace(/\.gguf$/i, ".json");
  }

  /** 扫描 models 目录重建模型注册表 */
  async scanModels(): Promise<LocalModel[]> {
    await fs.mkdir(this.modelsDir, { recursive: true });
    const entries = await fs.readdir(this.modelsDir, { withFileTypes: true });
    const models: LocalModel[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !/\.gguf$/i.test(entry.name)) continue;
      const modelPath = path.join(this.modelsDir, entry.name);
      const sidecar: { url?: string; sha256?: string; status?: LocalModel["status"]; downloadedAt?: string } = {};
      try {
        Object.assign(sidecar, JSON.parse(await fs.readFile(this.sidecarPath(modelPath), "utf8")));
      } catch {
        // 无侧车视为手工放置的模型
      }
      const stat = await fs.stat(modelPath);
      models.push({
        id: entry.name.replace(/\.gguf$/i, ""),
        fileName: entry.name,
        sizeBytes: stat.size,
        url: sidecar.url,
        sha256: sidecar.sha256,
        status: sidecar.status === "error" ? "error" : "downloaded",
        downloadedAt: sidecar.downloadedAt ?? stat.mtime.toISOString(),
        path: modelPath,
      });
    }
    return models.sort((a, b) => a.fileName.localeCompare(b.fileName));
  }

  /** 全量状态快照 */
  async getState(): Promise<ModelRuntimeState> {
    const models = await this.scanModels();
    const handle = this.llama.getHandle();
    const binPath = this.llama.resolveBinary();
    const envBin = process.env.AERVOX_LLAMA_SERVER_PATH?.trim();
    const source = binPath
      ? envBin
        ? "env"
        : binPath === "llama-server"
          ? "default"
          : "env"
      : "missing";
    const downloads = [...this.tasks.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(({ controller: _c, partPath: _p, ...task }) => task);

    return {
      models,
      runtime: {
        status: handle.status,
        pid: handle.pid,
        port: handle.port ?? undefined,
        modelId: handle.modelId ?? undefined,
        binPath: binPath ?? undefined,
        startedAt: handle.startedAt ?? undefined,
        error: handle.error ?? undefined,
        logs: handle.logs,
        metrics: this.metricSamples.length > 0 ? [...this.metricSamples] : undefined,
      },
      params: { ...this.lastParams },
      downloads,
      llamaServer: {
        configured: this.llama.configured,
        binPath: binPath ?? undefined,
        source,
        maxConcurrentDownloads: this.maxConcurrentDownloads,
      },
    };
  }

  /** 订阅状态变更（SSE）；返回退订函数 */
  subscribe(listener: (state: ModelRuntimeState) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** 广播（并发节流 ~200ms），错误吞掉以免拖垮循环 */
  private emit(): void {
    const now = Date.now();
    if (now - this.lastEmitAt < 200) return;
    this.lastEmitAt = now;
    void this.getState()
      .then((state) => {
        for (const listener of this.subscribers) listener(state);
      })
      .catch(() => undefined);
  }

  /** 精选模型目录 */
  getCatalog(): ModelCatalogEntry[] {
    return this.catalog;
  }

  /** 发起下载：进入队列（排队或立即执行） */
  async startDownload(request: ModelDownloadRequest): Promise<ModelRuntimeState> {
    const fileName = request.fileName ?? this.basenameFromUrl(request.url);
    if (!/\.gguf$/i.test(fileName) && !request.fileName) {
      throw new Error("invalid_model_url: 模型文件需为 .gguf 后缀");
    }
    const id = fileName.replace(/\.gguf$/i, "");
    const models = await this.scanModels();
    if (models.some((m) => m.id === id)) {
      throw new Error(`model_exists: 模型「${id}」已存在`);
    }
    if (this.tasks.has(id)) {
      throw new Error(`download_busy: 模型「${id}」已在下载队列`);
    }
    const destPath = path.join(this.modelsDir, fileName);
    const task: TaskState = {
      id,
      url: request.url,
      fileName,
      modelId: id,
      status: "queued",
      rateLimitBps: request.rateLimitBps,
      receivedBytes: 0,
      expectedSha256: request.sha256,
      autoStart: request.autoStart,
    };
    this.tasks.set(id, task);
    this.queue.push(id);
    this.pump();
    this.emit();
    return this.getState();
  }

  /** 推进队列：并发上限内逐任务执行 */
  private pump(): void {
    while (this.runningCount < this.maxConcurrentDownloads && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;
      const task = this.tasks.get(id);
      if (!task || task.status !== "queued") continue;
      this.runningCount += 1;
      void this.runTask(id).catch(() => undefined);
    }
  }

  private async runTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    try {
      if (!task) return;
      task.status = "running";
      task.controller = new AbortController();
      const destPath = path.join(this.modelsDir, task.fileName);
      task.partPath = `${destPath}.part`;
      let resumeFrom = 0;
      try {
        const ps = await fs.stat(task.partPath);
        if (ps.isFile()) resumeFrom = ps.size;
      } catch {
        // 从头
      }
      task.resumableFrom = resumeFrom > 0 ? resumeFrom : undefined;
      task.receivedBytes = resumeFrom;
      task.error = undefined;
      this.emit();

      const result = await downloadToFile({
        url: task.url,
        destPath,
        sha256: task.expectedSha256,
        signal: task.controller.signal,
        resumeOffsetBytes: resumeFrom,
        rateLimitBps: task.rateLimitBps ?? 0,
        onProgress: (p) => {
          task.receivedBytes = p.receivedBytes;
          task.totalBytes = p.totalBytes;
          this.emit();
        },
      });
      // 侧车：下载无显式 sha256 时记录实际值
      await fs.writeFile(
        this.sidecarPath(destPath),
        JSON.stringify({ url: task.url, sha256: result.sha256, status: "downloaded", downloadedAt: new Date().toISOString() }),
        "utf8",
      ).catch(() => undefined);
      task.status = "done";
      task.resumableFrom = undefined;
      this.tasks.delete(id); // 完成后移出活动队列（模型进入注册表）
      if (task.autoStart) {
        try {
          await this.start({ modelId: id });
        } catch (error) {
          task.error = `autoStart 失败: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    } catch (error) {
      const aborted = error instanceof Error && (error.name === "AbortError" || (error as ModelDownloadError).kind === "aborted");
      if (aborted) {
        // 暂停或取消：保持 paused/cancelled 由调用方设置；此处仅清理标记
        const t = this.tasks.get(id);
        if (t && t.status === "running") t.status = "paused";
      } else {
        const t = this.tasks.get(id);
        if (t) {
          t.status = "error";
          t.error = error instanceof ModelDownloadError ? error.message : error instanceof Error ? error.message : "下载失败";
        }
      }
    } finally {
      this.runningCount -= 1;
      this.emit();
      this.pump();
    }
  }

  /** 暂停（保留 .part 供续传） */
  async pauseDownload(id: string): Promise<ModelRuntimeState> {
    const task = this.tasks.get(id);
    if (!task || task.status === "done" || task.status === "cancelled" || task.status === "error") {
      throw new Error("task_not_found: 下载任务不存在或已结束");
    }
    if (task.status !== "running") return this.getState();
    task.controller?.abort();
    task.status = "paused";
    this.emit();
    return this.getState();
  }

  /** 恢复（重新入队，.part 续传） */
  async resumeDownload(id: string): Promise<ModelRuntimeState> {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error("task_not_found: 下载任务不存在");
    }
    if (task.status !== "paused") return this.getState();
    task.status = "queued";
    this.queue.push(id);
    this.pump();
    this.emit();
    return this.getState();
  }

  /** 取消（删除 .part） */
  async cancelDownload(id: string): Promise<ModelRuntimeState> {
    const task = this.tasks.get(id);
    if (!task || task.status === "done" || task.status === "cancelled") {
      throw new Error("task_not_found: 下载任务不存在或已结束");
    }
    if (task.status === "running") {
      task.controller?.abort();
    }
    task.status = "cancelled";
    await fs.rm(task.partPath ?? `${path.join(this.modelsDir, task.fileName)}.part`, { force: true }).catch(() => undefined);
    this.tasks.delete(id);
    this.emit();
    this.pump();
    return this.getState();
  }

  /** 删除已下载模型（运行中禁止） */
  async deleteModel(modelId: string): Promise<ModelRuntimeState> {
    const models = await this.scanModels();
    const wantedId = modelId.replace(/\.gguf$/i, "");
    const model = models.find((m) => m.id === wantedId || m.fileName === modelId);
    if (!model) {
      throw new Error(`model_not_found: 未找到模型「${modelId}」`);
    }
    const handle = this.llama.getHandle();
    if (handle.modelId === model.id && (handle.status === "running" || handle.status === "starting")) {
      throw new Error("llama_server_busy: 模型运行中，请先停止本地模型运行时（POST /v1/model-runtime/stop）");
    }
    await fs.rm(model.path, { force: true });
    await fs.rm(this.sidecarPath(model.path), { force: true });
    await fs.rm(`${model.path}.part`, { force: true });
    return this.getState();
  }

  /** 启动 llama-server */
  async start(request: ModelRuntimeStartRequest): Promise<ModelRuntimeState> {
    if (this.llama.running) {
      throw new Error("llama_server_busy: 本地模型运行时已在运行");
    }
    const models = await this.scanModels();
    const wantedId = request.modelId.replace(/\.gguf$/i, "");
    const model = models.find((m) => m.id === wantedId || m.fileName === request.modelId);
    if (!model) {
      throw new Error(`model_not_found: 未找到模型「${request.modelId}」（已下载：${models.map((m) => m.fileName).join(", ") || "无"}）`);
    }
    const merged: LlamaRuntimeParams = { ...this.lastParams, ...(request.params ?? {}) };
    this.lastParams = merged;
    await this.llama.start(model, merged);
    this.metricSamples.length = 0;
    return this.getState();
  }

  /** 停止当前 llama-server（幂等） */
  async stop(): Promise<ModelRuntimeState> {
    await this.llama.stop();
    this.metricSamples.length = 0;
    return this.getState();
  }

  /** 采样运行指标（llama.cpp /metrics；失败静默） */
  private async sampleMetrics(): Promise<void> {
    if (!this.llama.running || this.llama.getHandle().port === null) return;
    try {
      const sample = await this.llama.sampleMetrics();
      if (sample) {
        this.metricSamples.push(sample);
        if (this.metricSamples.length > 8) this.metricSamples.shift();
      }
    } catch {
      // 采样失败静默
    }
  }

  /** 应用关闭钩子 */
  async dispose(): Promise<void> {
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    for (const task of this.tasks.values()) task.controller?.abort();
    await this.llama.stop().catch(() => undefined);
  }

  private basenameFromUrl(url: string): string {
    try {
      const name = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
      return name || "model.gguf";
    } catch {
      return "model.gguf";
    }
  }
}
