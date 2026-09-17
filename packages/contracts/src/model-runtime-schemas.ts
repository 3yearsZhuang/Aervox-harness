import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

/** llama-server 运行时状态（易失，内存持有） */
export const llamaRuntimeStatusSchema = z.enum([
  "idle",
  "starting",
  "running",
  "stopping",
  "error",
]);

/** 已下载 / 下载中的本地模型条目（以 <models>/<file>.json 侧车元数据为真源） */
export const localModelSchema = z.object({
  id: z.string().min(1),
  fileName: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().optional(),
  url: z.string().url().optional(),
  sha256: z.string().optional(),
  status: z.enum(["downloaded", "downloading", "error"]).default("downloaded"),
  downloadedAt: z.string().datetime().optional(),
  path: z.string().min(1),
  /** 模型注册元信息异常（如校验失败残留标记） */
  error: z.string().optional(),
});

/** llama-server 启动参数（详见 llama.cpp server 命令行） */
export const llamaRuntimeParamsSchema = z.object({
  port: z.number().int().min(1024).max(65535).default(8080),
  ctxSize: z.number().int().positive().default(8192),
  gpuLayers: z.number().int().min(0).default(99),
  threads: z.number().int().positive().default(4),
});

/** 运行指标采样（llama.cpp /metrics tokens/s；非持久化） */
export const llamaMetricSampleSchema = z.object({
  at: z.string().datetime(),
  tokensPerSec: z.number().nonnegative().optional(),
  promptTokensPerSec: z.number().nonnegative().optional(),
});

/** 下载任务（多任务队列；状态机 queued→running→done|error|cancelled|paused，paused 可 resume） */
export const downloadTaskSchema = z.object({
  id: z.string().min(1),
  url: z.string().url(),
  fileName: z.string().min(1),
  modelId: z.string().min(1),
  status: z.enum(["queued", "running", "paused", "done", "error", "cancelled"]),
  receivedBytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().nonnegative().nullable().optional(),
  /** 断点续传基准（.part 既有字节 / 暂停点） */
  resumableFrom: z.number().int().nonnegative().optional(),
  /** 限速（bytes/sec，0 或缺省不限） */
  rateLimitBps: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});

/** 精选 GGUF 目录条目（内置清单；任意 URL 下载入口仍保留） */
export const modelCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  family: z.string().min(1),
  quant: z.string().min(1),
  sizeLabel: z.string().min(1),
  sizeBytes: z.number().int().positive().optional(),
  url: z.string().url(),
  sha256: z.string().optional(),
  recommendedParams: llamaRuntimeParamsSchema.partial().optional(),
});

/** 模型运行时全量状态快照 */
export const modelRuntimeStateSchema = z.object({
  models: z.array(localModelSchema),
  runtime: z.object({
    status: llamaRuntimeStatusSchema,
    pid: z.number().int().positive().nullable().optional(),
    port: z.number().int().positive().optional(),
    modelId: z.string().optional(),
    binPath: z.string().optional(),
    startedAt: z.string().datetime().optional(),
    error: z.string().optional(),
    /** llama-server stderr 环形缓冲 */
    logs: z.array(z.string()).optional(),
    /** 运行指标采样（最近 N 条） */
    metrics: z.array(llamaMetricSampleSchema).optional(),
  }),
  params: llamaRuntimeParamsSchema.optional(),
  /** 多任务下载队列（含执行中与排队任务） */
  downloads: z.array(downloadTaskSchema).default([]),
  llamaServer: z
    .object({
      configured: z.boolean(),
      binPath: z.string().optional(),
      source: z.enum(["env", "default", "missing"]).default("missing"),
      /** 下载并发上限（服务端配置） */
      maxConcurrentDownloads: z.number().int().positive().default(2),
    })
    .default({ configured: false, source: "missing", maxConcurrentDownloads: 2 }),
});

/** 发起下载请求 */
export const modelDownloadRequestSchema = z.object({
  url: z.string().url(),
  sha256: z.string().optional(),
  fileName: z.string().optional(),
  /** 下载完成后自动启动 llama-server 并联动 LLM 预设 */
  autoStart: z.boolean().optional().default(false),
  /** 限速（bytes/sec，缺省不限） */
  rateLimitBps: z.number().int().nonnegative().optional(),
});

/** 启动本地模型运行时请求 */
export const modelRuntimeStartRequestSchema = z.object({
  modelId: z.string().min(1),
  params: llamaRuntimeParamsSchema.partial().optional(),
});

/** SSE 状态推送事件载荷（与 state 快照一致；event=snapshot） */
export const modelRuntimeEventSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("snapshot"), data: modelRuntimeStateSchema }),
  z.object({ event: z.literal("error"), data: z.object({ message: z.string() }) }),
]);

export type LlamaRuntimeStatus = z.infer<typeof llamaRuntimeStatusSchema>;
export type LocalModel = z.infer<typeof localModelSchema>;
export type LlamaRuntimeParams = z.infer<typeof llamaRuntimeParamsSchema>;
export type LlamaMetricSample = z.infer<typeof llamaMetricSampleSchema>;
export type DownloadTask = z.infer<typeof downloadTaskSchema>;
export type ModelCatalogEntry = z.infer<typeof modelCatalogEntrySchema>;
export type ModelRuntimeState = z.infer<typeof modelRuntimeStateSchema>;
export type ModelDownloadRequest = z.infer<typeof modelDownloadRequestSchema>;
export type ModelRuntimeStartRequest = z.infer<typeof modelRuntimeStartRequestSchema>;
export type ModelRuntimeEvent = z.infer<typeof modelRuntimeEventSchema>;
