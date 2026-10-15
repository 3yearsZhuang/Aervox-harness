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
 *
 * v3（CR-054 迭代）：状态持久化与启动恢复——
 * - 未完结下载任务（queued/running/paused）与 lastParams 落盘 <modelsDir>/runtime-state.json，
 *   服务重建后自动恢复队列（.part 断点续传）；paused 保持暂停待手动继续；
 * - 上次会话末仍在运行的 llama-server 记录 autoStart，重启后按原参数自动拉起（失败留痕不阻断）；
 * - state.runtime 曝光 restored（本次恢复任务数）与 resume（运行中＝下次自动恢复）。
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
import { unavailableModelRuntimeDriver, type ModelRuntimeDriver } from "./driver.js";

export interface ModelRuntimeServiceOptions {
  /** 模型落盘目录（缺省 <repo>/data/models） */
  modelsDir?: string;
  /** 下载并发上限（缺省 2） */
  maxConcurrentDownloads?: number;
  /** 指标采样间隔 ms（缺省 2000；0 关闭） */
  metricsIntervalMs?: number;
  /** 自定义或注入的模型运行时驱动 SPI（缺省为不可用；具体实现由组合根提供） */
  driver?: ModelRuntimeDriver | null;
  stopTimeoutMs?: number;
  /** 单文件下载体积上限 bytes（缺省 64 GiB；0 关闭） */
  maxDownloadBytes?: number;
  /** 单次下载时长上限 ms（缺省 0 不限；设置后超时中止并清理残片） */
  maxDownloadDurationMs?: number;
}

interface TaskState extends DownloadTask {
  controller?: AbortController;
  partPath?: string;
  /** 期望校验值（用户提供时强校验） */
  expectedSha256?: string;
  /** 完成后自动启动并联动预设 */
  autoStart?: boolean;
}

/** 持久化状态文件（<modelsDir>/runtime-state.json，version=1；损坏/缺失视为无恢复） */
interface PersistedRuntimeState {
  version: 1;
  savedAt: string;
  /** 最近一次启动参数（重启后沿用） */
  params?: LlamaRuntimeParams;
  /** 未完结下载任务（queued/running/paused） */
  downloads?: Array<{
    id: string;
    url: string;
    fileName: string;
    modelId: string;
    status: "queued" | "running" | "paused";
    receivedBytes: number;
    rateLimitBps?: number;
    expectedSha256?: string;
    autoStart?: boolean;
  }>;
  /** 最近一次 llama-server 运行（dispose 时仍在运行则 autoStart=true，重启自动拉起） */
  runtime?: { autoStart: boolean; modelId: string; params: LlamaRuntimeParams };
}

const RUNTIME_STATE_FILE = "runtime-state.json";

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
  private readonly llama: ModelRuntimeDriver;
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
  private disposed = false;
  private generation = 0;
  private readonly stopTimeoutMs: number;
  private readonly maxDownloadBytes: number;
  private readonly maxDownloadDurationMs: number;
  private metricsInFlight = false;
  private closing: Promise<void> | null = null;
  private stopping: Promise<unknown> | null = null;
  private starting: Promise<ModelRuntimeState> | null = null;
  private readonly downloads = new Set<Promise<void>>();
  /** 本次会话从持久化恢复的任务数（state.runtime.restored 曝光） */
  private restoredSnapshot: { at: string; downloads: number } | null = null;
  /** 落盘串行链（原子写入，避免并发写坏文件） */
  private persistChain: Promise<void> = Promise.resolve();

  private assertOpen(): void { if (this.disposed) throw new Error("model_runtime_disposed"); }
  private async bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("model_runtime_stop_timeout")), this.stopTimeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private stopDriver(): Promise<unknown> {
    if (!this.stopping) {
      this.generation++;
      this.stopping = Promise.resolve().then(() => this.llama.stop()).finally(() => { this.stopping = null; });
    }
    return this.bounded(this.stopping);
  }

  get driver(): ModelRuntimeDriver {
    return this.llama;
  }

  constructor(options: ModelRuntimeServiceOptions = {}) {
    this.modelsDir = options.modelsDir ?? path.join(process.cwd(), "data", "models");
    this.maxConcurrentDownloads = options.maxConcurrentDownloads ?? 2;
    this.catalog = DEFAULT_CATALOG;
    this.llama = options.driver ?? unavailableModelRuntimeDriver;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
    this.maxDownloadBytes = options.maxDownloadBytes ?? 64 * 1024 ** 3;
    this.maxDownloadDurationMs = options.maxDownloadDurationMs ?? 0;
    const metricsInterval = options.metricsIntervalMs ?? 2000;
    if (metricsInterval > 0) {
      this.metricsTimer = setInterval(() => {
        void this.sampleMetrics();
      }, metricsInterval);
      this.metricsTimer.unref?.();
    }
    // 服务重建（进程重启 / 热重载）后异步恢复队列与运行时
    void this.restore();
  }

  private persistedPath(): string {
    return path.join(this.modelsDir, RUNTIME_STATE_FILE);
  }

  private partPathOf(task: TaskState): string {
    return `${path.join(this.modelsDir, task.fileName)}.part`;
  }

  /**
   * 归一模型文件名（显式名/URL 派生名/持久化恢复名三路共用）：
   * 单次解码后要求为纯 basename，拒绝空、`.`/`..`、路径分隔符与 NUL、超长，强制 .gguf 后缀。
   */
  private normalizeModelFileName(raw: string): string {
    let name = raw;
    try {
      name = decodeURIComponent(raw);
    } catch {
      name = raw;
    }
    name = name.trim();
    if (!name) throw new Error("invalid_model_file_name: 模型文件名为空");
    if (name.includes("/") || name.includes("\\") || name.includes("\0")) {
      throw new Error("invalid_model_file_name: 模型文件名不得包含路径分隔符");
    }
    if (name === "." || name === "..") throw new Error("invalid_model_file_name: 模型文件名不合法");
    if (name.length > 200) throw new Error("invalid_model_file_name: 模型文件名过长");
    if (!/\.gguf$/i.test(name)) throw new Error("invalid_model_url: 模型文件需为 .gguf 后缀");
    return name;
  }

  /** 根包含断言：目标必须是模型目录的直接子文件（纵深防御，防越根写入） */
  private assertWithinModelsDir(target: string): void {
    const root = path.resolve(this.modelsDir);
    if (path.dirname(path.resolve(target)) !== root) {
      throw new Error("invalid_model_file_name: 模型路径超出模型目录");
    }
  }

  /** 拒绝符号链接目标（防经 symlink 把字节写出模型根） */
  private async assertNotSymlink(target: string): Promise<void> {
    let stat: Awaited<ReturnType<typeof fs.lstat>>;
    try {
      stat = await fs.lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("invalid_model_file_name: 拒绝符号链接目标");
  }

  /** 读取持久化状态（缺失/损坏静默返回 null） */
  private async loadPersisted(): Promise<PersistedRuntimeState | null> {
    try {
      const data = JSON.parse(await fs.readFile(this.persistedPath(), "utf8")) as PersistedRuntimeState;
      return data?.version === 1 ? data : null;
    } catch {
      return null;
    }
  }

  /** 状态落盘（原子：tmp + rename；串行链防并发写坏；失败静默不阻断下载流） */
  private persist(): void {
    this.persistChain = this.persistChain.then(async () => {
      try {
        const data: PersistedRuntimeState = {
          version: 1,
          savedAt: new Date().toISOString(),
          params: { ...this.lastParams },
          downloads: [...this.tasks.values()]
            .filter((t) => t.status === "queued" || t.status === "running" || t.status === "paused")
            .map(({ controller: _c, partPath: _p, ...t }) => ({
              id: t.id,
              url: t.url,
              fileName: t.fileName,
              modelId: t.modelId,
              status: t.status as "queued" | "running" | "paused",
              receivedBytes: t.receivedBytes ?? 0,
              rateLimitBps: t.rateLimitBps,
              expectedSha256: t.expectedSha256,
              autoStart: t.autoStart,
            })),
          runtime: {
            autoStart: this.llama.running,
            modelId: this.llama.getHandle().modelId ?? "",
            params: { ...this.lastParams },
          },
        };
        const tmp = `${this.persistedPath()}.tmp`;
        await fs.mkdir(this.modelsDir, { recursive: true });
        await fs.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
        await fs.rename(tmp, this.persistedPath());
      } catch {
        // 持久化失败静默（不阻断下载流）
      }
    });
  }

  /** 服务重建后恢复：队列任务 + 启动参数 + 运行时自动拉起；失败不阻断启动 */
  private async restore(): Promise<void> {
    let saved: PersistedRuntimeState | null = null;
    try {
      saved = await this.loadPersisted();
      if (!saved) return;
      const models = await this.scanModels();
      if (saved.params) this.lastParams = { ...DEFAULT_PARAMS, ...saved.params };
      let restoredCount = 0;
      for (const t of saved.downloads ?? []) {
        let fileName: string;
        try {
          fileName = this.normalizeModelFileName(t.fileName);
        } catch {
          continue; // 非法持久化名（历史残留/被篡改）：丢弃该项，不重建任务
        }
        if (this.tasks.has(t.id)) continue;
        if (models.some((m) => m.id === t.id)) continue; // 已完成入库（或已删）的不再恢复
        const task: TaskState = {
          id: t.id,
          url: t.url,
          fileName,
          modelId: t.modelId,
          status: t.status === "paused" ? "paused" : "queued",
          receivedBytes: t.receivedBytes ?? 0,
          rateLimitBps: t.rateLimitBps,
          expectedSha256: t.expectedSha256,
          autoStart: t.autoStart,
        };
        this.tasks.set(t.id, task);
        if (task.status === "queued") this.queue.push(t.id);
        restoredCount += 1;
      }
      // paused 任务同步 .part 实际字节（断点基准）
      for (const task of this.tasks.values()) {
        if (task.status !== "paused") continue;
        try {
          const ps = await fs.stat(this.partPathOf(task));
          if (ps.isFile()) task.receivedBytes = ps.size;
        } catch {
          // 无 .part（暂存被清）仍保留 paused 状态，恢复时从头
        }
      }
      if (this.queue.length > 0) this.pump();
      if (restoredCount > 0) {
        this.restoredSnapshot = { at: new Date().toISOString(), downloads: restoredCount };
      }
      // 上次会话末仍在运行 → 按原参数自动拉起
      const rt = saved.runtime;
      if (rt?.autoStart && rt.modelId && !this.llama.running) {
        const model = (await this.scanModels()).find((m) => m.id === rt.modelId);
        if (model) {
          try {
            await this.start({ modelId: model.id, params: rt.params });
          } catch {
            // 拉起失败留痕于 runtime.error（llama 管理器已处理），后续不再自动重试
          }
        }
      }
      this.emit();
    } catch {
      // 恢复失败不阻断服务启动
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
      const sidecar: { url?: string; sha256?: string; status?: LocalModel["status"]; downloadedAt?: string; error?: string } = {};
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
        error: sidecar.error,
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
        restored: this.restoredSnapshot ?? undefined,
        resume: this.llama.running
          ? { enabled: true, modelId: handle.modelId ?? undefined }
          : undefined,
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
    this.assertOpen();
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** 广播（并发节流 ~200ms），错误吞掉以免拖垮循环 */
  private emit(): void {
    if (this.disposed) return;
    const now = Date.now();
    if (now - this.lastEmitAt < 200) return;
    this.lastEmitAt = now;
    void this.getState()
      .then((state) => {
        if (!this.disposed) for (const listener of this.subscribers) listener(state);
      })
      .catch(() => undefined);
  }

  /** 精选模型目录 */
  getCatalog(): ModelCatalogEntry[] {
    return this.catalog;
  }

  /** 发起下载：进入队列（排队或立即执行） */
  async startDownload(request: ModelDownloadRequest): Promise<ModelRuntimeState> {
    this.assertOpen();
    const fileName = this.normalizeModelFileName(request.fileName ?? this.basenameFromUrl(request.url));
    const id = fileName.replace(/\.gguf$/i, "");
    const models = await this.scanModels();
    if (models.some((m) => m.id === id)) {
      throw new Error(`model_exists: 模型「${id}」已存在`);
    }
    if (this.tasks.has(id)) {
      throw new Error(`download_busy: 模型「${id}」已在下载队列`);
    }
    const destPath = path.join(this.modelsDir, fileName);
    this.assertWithinModelsDir(destPath);
    await this.assertNotSymlink(destPath);
    await this.assertNotSymlink(`${destPath}.part`);
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
    this.persist();
    this.emit();
    return this.getState();
  }

  /** 推进队列：并发上限内逐任务执行 */
  private pump(): void {
    if (this.disposed) return;
    while (this.runningCount < this.maxConcurrentDownloads && this.queue.length > 0) {
      const id = this.queue.shift();
      if (!id) break;
      const task = this.tasks.get(id);
      if (!task || task.status !== "queued") continue;
      this.runningCount += 1;
      const operation = this.runTask(id).finally(() => this.downloads.delete(operation));
      this.downloads.add(operation);
      void operation.catch(() => undefined);
    }
  }

  private async runTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    try {
      if (!task) return;
      task.status = "running";
      task.controller = new AbortController();
      const destPath = path.join(this.modelsDir, task.fileName);
      this.assertWithinModelsDir(destPath);
      await this.assertNotSymlink(destPath);
      await this.assertNotSymlink(`${destPath}.part`);
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
        maxBytes: this.maxDownloadBytes,
        maxDurationMs: this.maxDownloadDurationMs,
        rootDir: this.modelsDir,
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
          const message = `autoStart 失败: ${error instanceof Error ? error.message : String(error)}`;
          task.error = message;
          // 任务已移出队列，失败不以任务承载：改写侧车由注册表（models[].error）曝光
          await fs.writeFile(
            this.sidecarPath(destPath),
            JSON.stringify({ url: task.url, sha256: result.sha256, status: "downloaded", error: message, downloadedAt: new Date().toISOString() }),
            "utf8",
          ).catch(() => undefined);
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
      this.persist();
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
    this.persist();
    this.emit();
    return this.getState();
  }

  /** 恢复（重新入队，.part 续传） */
  async resumeDownload(id: string): Promise<ModelRuntimeState> {
    this.assertOpen();
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error("task_not_found: 下载任务不存在");
    }
    if (task.status !== "paused") return this.getState();
    task.status = "queued";
    this.queue.push(id);
    this.pump();
    this.persist();
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
    await fs.rm(task.partPath ?? this.partPathOf(task), { force: true }).catch(() => undefined);
    this.tasks.delete(id);
    this.persist();
    this.emit();
    this.pump();
    return this.getState();
  }

  /** 删除已下载模型（运行中禁止） */
  async deleteModel(modelId: string): Promise<ModelRuntimeState> {
    this.assertOpen();
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
    this.assertOpen();
    if (this.starting || this.stopping || this.llama.running) {
      throw new Error("llama_server_busy: 本地模型运行时已在运行");
    }
    const operation = this.startInternal(request);
    this.starting = operation;
    try { return await operation; } finally { this.starting = null; }
  }

  private async startInternal(request: ModelRuntimeStartRequest): Promise<ModelRuntimeState> {
    const generation = ++this.generation;
    const models = await this.scanModels();
    this.assertOpen();
    if (generation !== this.generation) throw new Error("model_runtime_start_cancelled");
    const wantedId = request.modelId.replace(/\.gguf$/i, "");
    const model = models.find((m) => m.id === wantedId || m.fileName === request.modelId);
    if (!model) {
      throw new Error(`model_not_found: 未找到模型「${request.modelId}」（已下载：${models.map((m) => m.fileName).join(", ") || "无"}）`);
    }
    const merged: LlamaRuntimeParams = { ...this.lastParams, ...(request.params ?? {}) };
    this.lastParams = merged;
    try {
      await this.llama.start(model, merged);
    } finally {
      if (generation !== this.generation || this.disposed) {
        // A stop issued before start settled may have observed no process.
        // Keep the start slot occupied until a post-start stop has reclaimed it.
        if (this.stopping) await this.bounded(this.stopping);
        await this.stopDriver();
      }
    }
    if (generation !== this.generation || this.disposed) throw new Error("model_runtime_start_cancelled");
    this.metricSamples.length = 0;
    this.persist();
    return this.getState();
  }

  /** 停止当前 llama-server（幂等） */
  async stop(): Promise<ModelRuntimeState> {
    await this.bounded(Promise.all([this.stopDriver(), this.starting?.catch(() => undefined)]));
    this.metricSamples.length = 0;
    return this.getState();
  }

  /** 采样运行指标（llama.cpp /metrics；失败静默；在途采样时不叠加请求） */
  private async sampleMetrics(): Promise<void> {
    if (this.disposed || this.metricsInFlight || !this.llama.running || this.llama.getHandle().port === null) return;
    this.metricsInFlight = true;
    const generation = this.generation;
    try {
      if (typeof this.llama.sampleMetrics === "function") {
        const sample = await this.llama.sampleMetrics();
        if (sample && !this.disposed && generation === this.generation) {
          this.metricSamples.push(sample);
          if (this.metricSamples.length > 8) this.metricSamples.shift();
        }
      }
    } catch {
      // 采样失败静默
    } finally {
      this.metricsInFlight = false;
    }
  }

  /** 应用关闭钩子（先落盘快照：未完结任务恢复队列 + llama.running → 下次 autoStart） */
  dispose(): Promise<void> {
    if (this.closing) return this.closing;
    this.disposed = true;
    this.generation++;
    this.persist();
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.metricsTimer = null;
    this.subscribers.clear();
    this.queue.length = 0;
    for (const task of this.tasks.values()) task.controller?.abort();
    // 先等落盘链完成（快照在 stop 前构造：llama.running → autoStart），再并发停止 driver 与下载
    this.closing = this.bounded(
      this.persistChain.then(() => Promise.all([this.stopDriver(), this.starting?.catch(() => undefined), ...this.downloads])),
    ).then(() => undefined);
    return this.closing;
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
