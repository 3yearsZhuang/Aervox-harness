/**
 * Aervox｜思隅 @aervox/api — 本地大语言模型运行时驱动 SPI（ModelRuntimeDriver）
 *
 * 核心目标：
 * - 将具体模型运行时（如 llama-server、Ollama、vLLM、MLX 等）的进程控制与指标探测
 *   与 ModelRuntimeService 解耦；
 * - 核心编排服务统一管理模型目录、下载队列与并发限速，通过 SPI 调度底层运行时驱动。
 */
import type {
  LlamaMetricSample,
  LlamaRuntimeParams,
  LlamaRuntimeStatus,
  LocalModel,
} from "@aervox/contracts";

export interface ModelRuntimeDriverHandle {
  pid: number | null;
  status: LlamaRuntimeStatus;
  port: number | null;
  modelId: string | null;
  startedAt: string | null;
  error: string | null;
  /** stderr 环形缓冲或诊断日志 */
  logs: string[];
}

export interface ModelRuntimeDriver {
  readonly id: string;
  readonly name: string;
  readonly configured: boolean;
  readonly running: boolean;
  resolveBinary(): string | null;
  getHandle(): ModelRuntimeDriverHandle;
  start(model: LocalModel, params: LlamaRuntimeParams): Promise<ModelRuntimeDriverHandle>;
  stop(): Promise<ModelRuntimeDriverHandle>;
  sampleMetrics?(): Promise<LlamaMetricSample | null>;
}
