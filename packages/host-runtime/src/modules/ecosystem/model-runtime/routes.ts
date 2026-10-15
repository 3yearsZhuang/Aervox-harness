import type { FastifyInstance } from "fastify";
import {
  modelDownloadRequestSchema,
  modelRuntimeStartRequestSchema,
} from "@aervox/contracts";
import type { ModelRuntimeService } from "./service.js";

export function registerModelRuntimeRoutes(app: FastifyInstance, service: ModelRuntimeService): void {
  // GET /v1/model-runtime/state — 全量状态
  app.get("/v1/model-runtime/state", async () => {
    return service.getState();
  });

  // GET /v1/model-runtime/catalog — 内置精选 GGUF 目录（任意 URL 下载入口仍保留）
  app.get("/v1/model-runtime/catalog", async () => {
    return { entries: service.getCatalog() };
  });

  // GET /v1/model-runtime/events — SSE 实时状态推送（断线后由客户端回退轮询 state）
  app.get("/v1/model-runtime/events", async (req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const push = (state: unknown): void => {
      raw.write(`event: snapshot\ndata: ${JSON.stringify(state)}\n\n`);
    };
    const close = (): void => {
      clearInterval(heartbeat);
      unsub();
      if (!raw.destroyed) raw.end();
    };
    req.raw.on("close", close);
    const unsub = service.subscribe(push);
    // 建连即推一版快照
    void service.getState().then(push).catch(() => undefined);
    const heartbeat = setInterval(() => {
      if (!raw.destroyed) raw.write(": ping\n\n");
    }, 15_000);
  });

  // POST /v1/model-runtime/downloads — 发起下载（进入队列）
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
      const busy = message.startsWith("download_busy") || message.startsWith("model_exists");
      return reply.code(busy ? 409 : 400).send({
        code: busy ? "DOWNLOAD_BUSY" : "DOWNLOAD_FAILED",
        message,
      });
    }
  });

  // POST /v1/model-runtime/downloads/:taskId/pause|resume|cancel
  app.post("/v1/model-runtime/downloads/:taskId/pause", async (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    try {
      return await service.pauseDownload(taskId);
    } catch (err) {
      return reply.code(404).send({ code: "TASK_NOT_FOUND", message: err instanceof Error ? err.message : "任务不存在" });
    }
  });

  app.post("/v1/model-runtime/downloads/:taskId/resume", async (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    try {
      return await service.resumeDownload(taskId);
    } catch (err) {
      return reply.code(404).send({ code: "TASK_NOT_FOUND", message: err instanceof Error ? err.message : "任务不存在" });
    }
  });

  app.post("/v1/model-runtime/downloads/:taskId/cancel", async (req, reply) => {
    const { taskId } = req.params as { taskId: string };
    try {
      return await service.cancelDownload(taskId);
    } catch (err) {
      return reply.code(404).send({ code: "TASK_NOT_FOUND", message: err instanceof Error ? err.message : "任务不存在" });
    }
  });

  // POST /v1/model-runtime/start — 启动 llama-server
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
