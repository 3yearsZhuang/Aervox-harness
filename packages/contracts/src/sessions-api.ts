import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import type { ApiEndpoint } from "./http-api.js";
import { listSessionsResponseSchema, sessionItemSchema } from "./session-schemas.js";

extendZodWithOpenApi(z);
/** Each read is a bounded live projection; offset is not a snapshot cursor. */
export const sessionListQuerySchema = z.object({
  limit: z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).optional(),
  offset: z.string().regex(/^(?:0|[1-9][0-9]*)$/).refine(value => Number.isSafeInteger(Number(value))).optional(),
  projectId: z.string().min(1).max(128).optional(),
}).strict();
export const sessionsApi = {
  list: {
    method: "get", path: "/v1/sessions", operationId: "listSessions",
    summary: "读取最近更新的单页会话概要，分页不创建会话或切换执行", tags: ["Session"],
    query: sessionListQuerySchema, response: listSessionsResponseSchema,
    errors: { 400: "INVALID_SESSION_QUERY" },
    validationErrorCode: "INVALID_SESSION_QUERY", validationErrorMessage: "Invalid session query",
  },
  get: {
    method: "get", path: "/v1/sessions/{sessionId}", operationId: "getSession",
    summary: "按身份读取已有会话概要，不存在时拒绝，不创建替代会话", tags: ["Session"],
    params: z.object({ sessionId: z.string().min(1).max(128) }).strict(),
    query: z.object({}).strict(), response: sessionItemSchema,
    errors: { 400: "INVALID_SESSION_QUERY", 404: "SESSION_NOT_FOUND" },
    validationErrorCode: "INVALID_SESSION_QUERY", validationErrorMessage: "Invalid session query",
  },
} as const satisfies Record<string, ApiEndpoint>;
