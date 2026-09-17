import type { FastifyInstance } from "fastify";
import {
  modelDownloadRequestSchema,
  modelRuntimeStartRequestSchema,
} from "@aervox/contracts";
import type { ModelRuntimeService } from "./service.js";

export function registerModelRuntimeRoutes(app: FastifyInstance, service: ModelRuntimeService): void {
  // GET /v1/model-runtime/state — 全量状态（模型注册表 / 运行时 / 下载进度 / llama-server 配置）
  app.get("/v1/model-runtime/state", async () => {
    return service.getState();
  });

  // POST /v1/model-runtime/downloads — 发起模型下载（单任务队列）
  app.post("/v1/model-runtime/downloads", async (req, reply) => {
    const parsed = modelDownloadRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_MODEL_DOWNLOAD_REQUEST",
        message: "Invalid model download payload",
        details: parsed.error.issues,
      });
    }
    try {
      return await service.startDownload(parsed.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "下载发起失败";
      const busy = message.startsWith("download_busy");
      return reply.code(busy ? 409 : 400).send({
        code: busy ? "DOWNLOAD_BUSY" : "DOWNLOAD_FAILED",
        message,
      });
    }
  });

  // POST /v1/model-runtime/downloads/cancel — 取消进行中的下载
  app.post("/v1/model-runtime/downloads/cancel", async () => {
    return service.cancelDownload();
  });

  // POST /v1/model-runtime/start — 启动 llama-server 服务指定模型
  app.post("/v1/model-runtime/start", async (req, reply) => {
    const parsed = modelRuntimeStartRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_MODEL_RUNTIME_START",
        message: "Invalid start payload",
        details: parsed.error.issues,
      });
    }
    try {
      return await service.start(parsed.data);
    } catch (err) {
      const message = err instanceof Error ? err.message : "启动失败";
      const busy = message.startsWith("llama_server_busy");
      return reply.code(busy ? 409 : 400).send({
        code: busy ? "RUNTIME_BUSY" : "RUNTIME_START_FAILED",
        message,
      });
    }
  });

  // POST /v1/model-runtime/stop — 停止当前 llama-server（幂等）
  app.post("/v1/model-runtime/stop", async () => {
    return service.stop();
  });

  // DELETE /v1/model-runtime/models/:modelId — 删除已下载模型（运行中禁止）
  app.delete("/v1/model-runtime/models/:modelId", async (req, reply) => {
    const { modelId } = req.params as { modelId: string };
    try {
      return await service.deleteModel(modelId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "删除失败";
      if (message.startsWith("llama_server_busy")) {
        return reply.code(409).send({ code: "RUNTIME_BUSY", message });
      }
      return reply.code(404).send({ code: "MODEL_NOT_FOUND", message });
    }
  });
}