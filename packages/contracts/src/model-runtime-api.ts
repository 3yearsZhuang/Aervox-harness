import { z } from "zod";
import type { ApiEndpoint } from "./http-api.js";
import { modelCatalogEntrySchema, modelDownloadRequestSchema, modelRuntimeStateSchema } from "./model-runtime-schemas.js";

export const modelCatalogResponseSchema = z.object({ entries: z.array(modelCatalogEntrySchema) });

/** Shared by Fastify registration, OpenAPI generation and every platform client. */
export const modelRuntimeApi = {
  state: {
    method: "get", path: "/v1/model-runtime/state", operationId: "getModelRuntimeState",
    summary: "读取本地模型运行时全量状态", tags: ["Model Runtime"], response: modelRuntimeStateSchema,
  },
  catalog: {
    method: "get", path: "/v1/model-runtime/catalog", operationId: "getModelRuntimeCatalog",
    summary: "读取内置 GGUF 模型目录", tags: ["Model Runtime"], response: modelCatalogResponseSchema,
  },
  download: {
    method: "post", path: "/v1/model-runtime/downloads", operationId: "createModelRuntimeDownload",
    summary: "创建本地模型下载任务", tags: ["Model Runtime"],
    body: modelDownloadRequestSchema, response: modelRuntimeStateSchema,
    validationErrorCode: "INVALID_MODEL_DOWNLOAD_REQUEST",
    errors: { 400: "DOWNLOAD_FAILED / INVALID_MODEL_DOWNLOAD_REQUEST", 409: "DOWNLOAD_BUSY" },
  },
} as const satisfies Record<string, ApiEndpoint>;
