import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import type { ApiEndpoint } from "./http-api.js";

extendZodWithOpenApi(z);
const id = z.string().min(1);
export const sessionHistoryQuerySchema = z.object({
  limit: z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).optional(),
  cursor: z.string().min(1).max(16_384).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
export const sessionHistoryMessageSchema = z.object({
  messageId: id.nullable(), versionId: id, version: z.number().int().min(1),
  role: z.enum(["user", "assistant", "system"]),
  contentKind: z.enum(["accepted_input", "message"]),
  content: z.string().nullable(), visibility: z.enum(["available", "withheld"]),
  legacy: z.boolean(), readOnly: z.boolean(), createdAt: z.string(),
}).refine(message => message.visibility === "withheld" ? message.content === null : message.content !== null)
  .openapi("SessionHistoryMessage");
export const sessionHistoryTurnSchema = z.object({
  turnId: id, status: z.string().min(1).max(64), isComplete: z.boolean(), createdAt: z.string(),
  messages: z.array(sessionHistoryMessageSchema).max(100),
}).openapi("SessionHistoryTurn");
export const sessionHistoryPageSchema = z.object({
  sessionId: id, items: z.array(sessionHistoryTurnSchema).max(50), nextCursor: z.string().min(1).max(16_384).regex(/^[A-Za-z0-9_-]+$/).nullable(),
}).openapi("SessionHistoryPage");
export type SessionHistoryPage = z.infer<typeof sessionHistoryPageSchema>;
export type SessionHistoryTurn = z.infer<typeof sessionHistoryTurnSchema>;
export type SessionHistoryMessage = z.infer<typeof sessionHistoryMessageSchema>;
export const sessionHistoryApi = {
  get: {
    method: "get", path: "/v1/sessions/{sessionId}/history", operationId: "getSessionHistoryPage",
    summary: "读取当前持久消息版本的单页历史，不执行模型或重建旧事件正文", tags: ["Conversation"],
    params: z.object({ sessionId: id.max(128) }).strict(), query: sessionHistoryQuerySchema,
    response: sessionHistoryPageSchema,
    errors: { 400: "INVALID_HISTORY_QUERY", 404: "SESSION_NOT_FOUND", 410: "HISTORY_CURSOR_EXPIRED", 422: "HISTORY_ITEM_TOO_LARGE" },
    validationErrorCode: "INVALID_HISTORY_QUERY", validationErrorMessage: "Invalid history query",
  },
} as const satisfies Record<string, ApiEndpoint>;
