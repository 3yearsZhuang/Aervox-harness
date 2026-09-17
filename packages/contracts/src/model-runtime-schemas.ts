import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

/** llama-server 运行时状态（易失，内存持有） */
export const llamaRuntimeStatusSchema = z.enum([
  "idle", // 未启动
  "starting", // 子进程已拉起，健康探测中
  "running", // 健康探测通过，可被 LLM Config 调用
  "stopping", // SIGTERM 已发，等待退出
  "error", // 启动/运行异常
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
});

/** llama-server 启动参数（详见 llama.cpp server 命令行） */
export const llamaRuntimeParamsSchema = z.object({
  port: z.number().int().min(1024).max(65535).default(8080),
  ctxSize: z.number().int().positive().default(8192),
  gpuLayers: z.number().int().min(0).default(99), // -ngl；-1 表示尽数卸载 CPU
  threads: z.number().int().positive().default(4),
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
  }),
  params: llamaRuntimeParamsSchema.optional(),
  download: z
    .object({
      active: z.boolean(),
      url: z.string().url().optional(),
      modelId: z.string().optional(),
      receivedBytes: z.number().int().nonnegative().optional(),
      totalBytes: z.number().int().nonnegative().nullable().optional(),
      status: z.enum(["running", "done", "error", "cancelled"]).optional(),
      error: z.string().optional(),
    })
    .default({ active: false }),
  llamaServer: z
    .object({
      configured: z.boolean(),
      binPath: z.string().optional(),
      source: z.enum(["env", "default", "missing"]).default("missing"),
    })
    .default({ configured: false, source: "missing" }),
});

/** 发起下载请求 */
export const modelDownloadRequestSchema = z.object({
  url: z.string().url(),
  sha256: z.string().optional(),
  fileName: z.string().optional(),
});

/** 启动本地模型运行时请求（缺省以 state.params 或默认值启动） */
export const modelRuntimeStartRequestSchema = z.object({
  modelId: z.string().min(1),
  params: llamaRuntimeParamsSchema.partial().optional(),
});

export type LlamaRuntimeStatus = z.infer<typeof llamaRuntimeStatusSchema>;
export type LocalModel = z.infer<typeof localModelSchema>;
export type LlamaRuntimeParams = z.infer<typeof llamaRuntimeParamsSchema>;
export type ModelRuntimeState = z.infer<typeof modelRuntimeStateSchema>;
export type ModelDownloadRequest = z.infer<typeof modelDownloadRequestSchema>;
export type ModelRuntimeStartRequest = z.infer<typeof modelRuntimeStartRequestSchema>;