/**
 * Aervox｜思隅 @aervox/api — 本地模型运行时编排服务（CR-054）
 *
 * 归置 `ecosystem/model-runtime`：
 * - 模型注册 = 扫描 `<data>/models/*.gguf` + 同名 `.json` 侧车元数据（url/sha256）动态重建；
 * - 下载 = 单任务串行队列（active 时拒绝新任务），进度存内存，失败/取消清理 .part；
 * - 进程 = LlamaServerManager 单例子进程，启动参数（port/ctx/ngl/threads）可持久覆盖；
 * - 状态快照构造差异查询视图，供 /v1/model-runtime/state 直出。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type {
  LlamaRuntimeParams,
  LocalModel,
  ModelDownloadRequest,
  ModelRuntimeState,
  ModelRuntimeStartRequest,
} from "@aervox/contracts";
import { downloadToFile, ModelDownloadError } from "./downloader.js";
import { LlamaServerManager, type LlamaServerManagerDeps } from "./llama-server.js";

export interface ModelRuntimeServiceOptions {
  /** 模型落盘目录（缺省 <repo>/data/models） */
  modelsDir?: string;
  /** 下载并发拒绝时的错误文案（测试断言用） */
  onDownloadProgress?: (progress: { receivedBytes: number; totalBytes: number | null }) => void;
  llamaDeps?: LlamaServerManagerDeps;
}

interface DownloadState {
  active: boolean;
  url?: string;
  modelId?: string;
  receivedBytes?: number;
  totalBytes?: number | null;
  status?: "running" | "done" | "error" | "cancelled";
  error?: string;
}

const DEFAULT_PARAMS: LlamaRuntimeParams = {
  port: 8080,
  ctxSize: 8192,
  gpuLayers: 99,
  threads: 4,
};

export class ModelRuntimeService {
  private readonly modelsDir: string;
  private readonly llama: LlamaServerManager;
  private readonly download: DownloadState = { active: false };
  private lastParams: LlamaRuntimeParams = { ...DEFAULT_PARAMS };
  private downloadController: AbortController | null = null;

  constructor(options: ModelRuntimeServiceOptions = {}) {
    this.modelsDir = options.modelsDir ?? path.join(process.cwd(), "data", "models");
    this.llama = new LlamaServerManager(options.llamaDeps);
  }

  private sidecarPath(modelPath: string): string {
    return modelPath.replace(/\.gguf$/i, ".json");
  }

  /** 扫描 models 目录重建模型注册表（运行时状态以磁盘文件为真源） */
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
        downloadedAt: sidecar.downloadedAt ?? (await fs.stat(modelPath).then((s) => s.mtime.toISOString())),
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
      },
      params: { ...this.lastParams },
      download: { ...this.download },
      llamaServer: { configured: this.llama.configured, binPath: binPath ?? undefined, source },
    };
  }

  /** 单任务队列发起下载；active 时抛错（409 语义） */
  async startDownload(request: ModelDownloadRequest): Promise<ModelRuntimeState> {
    if (this.download.active) {
      throw new Error("download_busy: 已有下载任务进行中");
    }
    const fileName = request.fileName ?? this.basenameFromUrl(request.url);
    if (!/\.gguf$/i.test(fileName) && !request.fileName) {
      throw new Error("invalid_model_url: 模型文件需为 .gguf 后缀");
    }
    const id = fileName.replace(/\.gguf$/i, "");
    const models = await this.scanModels();
    if (models.some((m) => m.id === id)) {
      throw new Error(`model_exists: 模型「${id}」已存在`);
    }

    const destPath = path.join(this.modelsDir, fileName);
    const sidecarPath = this.sidecarPath(destPath);
    this.download.active = true;
    this.download.url = request.url;
    this.download.modelId = id;
    this.download.status = "running";
    this.download.error = undefined;
    this.download.receivedBytes = 0;
    this.download.totalBytes = null;
    this.downloadController = new AbortController();

    await fs.writeFile(
      sidecarPath,
      JSON.stringify({ url: request.url, sha256: request.sha256, status: "downloading" }),
      "utf8",
    ).catch(() => undefined);

    try {
      const result = await downloadToFile({
        url: request.url,
        destPath,
        sha256: request.sha256,
        signal: this.downloadController.signal,
        onProgress: (p) => {
          this.download.receivedBytes = p.receivedBytes;
          this.download.totalBytes = p.totalBytes;
        },
      });
      await fs.writeFile(
        sidecarPath,
        JSON.stringify({
          url: request.url,
          sha256: result.sha256,
          status: "downloaded",
          downloadedAt: new Date().toISOString(),
        }),
        "utf8",
      ).catch(() => undefined);
      this.download.status = "done";
    } catch (error) {
      const aborted = error instanceof Error && error.name === "AbortError";
      this.download.status = aborted ? "cancelled" : "error";
      this.download.error = aborted
        ? undefined
        : error instanceof ModelDownloadError
          ? error.message
          : error instanceof Error
            ? error.message
            : "下载失败";
      if (!aborted) {
        await fs.rm(sidecarPath, { force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      this.download.active = false;
      this.downloadController = null;
    }
    return this.getState();
  }

  /** 取消进行中的下载（幂等） */
  async cancelDownload(): Promise<ModelRuntimeState> {
    this.downloadController?.abort();
    return this.getState();
  }

  /** 启动 llama-server（modelId 支持完整文件名或去掉 .gguf 的 id） */
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
    return this.getState();
  }

  /** 停止当前 llama-server（幂等） */
  async stop(): Promise<ModelRuntimeState> {
    await this.llama.stop();
    return this.getState();
  }

  /** 应用关闭钩子：终止子进程 */
  async dispose(): Promise<void> {
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