import type { ModuleDependencies } from "../../context.js";
import { ModelRuntimeService, type ModelRuntimeServiceOptions } from "./service.js";
import { registerModelRuntimeRoutes } from "./routes.js";
import { LlamaServerManager, type LlamaServerManagerDeps } from "./llama-server.js";
import { unavailableModelRuntimeDriver } from "./driver.js";
import path from "node:path";

export interface ModelRuntimeModuleOptions extends ModelRuntimeServiceOptions { llamaDeps?: LlamaServerManagerDeps }

/**
 * 模型运行时管理模块（CR-054）：
 * - 本地 GGUF 模型下载（流式 / 进度 / SHA-256 校验 / .part 原子落盘）；
 * - llama-server（llama.cpp）子进程生命周期（spawn / 健康探测 / 停止 / 崩溃留痕）；
 * - 与 `ecosystem/llm` 的 llamacpp 预设联动（UI 层一键切换 baseUrl/modelId）。
 */
export function registerModelRuntimeModule(
  ctx: ModuleDependencies<"app">,
  options: ModelRuntimeModuleOptions = {},
): ModelRuntimeService {
  const defaultDriver = process.env.AERVOX_EXTERNAL_MODEL_OWNER === "1"
    ? { ...unavailableModelRuntimeDriver, id: "externally-managed", name: "Native supervisor owns this model",
      start: async () => { throw new Error("model_runtime_owned_by_native_supervisor"); } }
    : new LlamaServerManager(options.llamaDeps);
  const modelsDir = options.modelsDir ?? (process.env.AERVOX_NATIVE_DATA_DIR ? path.join(process.env.AERVOX_NATIVE_DATA_DIR, "models") : undefined);
  const service = new ModelRuntimeService({ ...options, modelsDir, driver: options.driver === undefined ? defaultDriver : options.driver });
  registerModelRuntimeRoutes(ctx.app, service);

  // 应用关闭（进程退出 / 测试 teardown）时终止子进程
  ctx.app.addHook("onClose", async () => {
    await service.dispose();
  });

  return service;
}

export * from "./service.js";
export * from "./llama-server.js";
export * from "./downloader.js";
export * from "./driver.js";

export type { LlamaServerManagerDeps };
export type ModelRuntimePort = Pick<import("./service.js").ModelRuntimeService, "getState" | "start" | "stop">;
