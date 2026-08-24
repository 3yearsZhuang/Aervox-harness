/**
 * Aervox｜思隅 @aervox/contracts
 *
 * 对话流式协议（Turn/SSE）的机器可验证契约事实源。
 * 模式见 schemas.ts，OpenAPI 文档见 openapi.ts，规则依据 docs/contracts/STREAMING_PROTOCOL.md。
 */
import { z } from "zod";
import {
  cancelTurnResponseSchema,
  createTurnRequestSchema,
  createTurnResponseSchema,
  deltaEventDataSchema,
  doneEventDataSchema,
  errorEventDataSchema,
  messageEventDataSchema,
  redactedEventDataSchema,
  streamErrorCodeSchema,
  streamEventTypeSchema,
  turnStatusSchema,
  turnStreamEventSchema,
} from "./schemas.js";

export * from "./schemas.js";
export { openApiDocument } from "./openapi.js";

export type TurnStatus = z.infer<typeof turnStatusSchema>;
export type StreamEventType = z.infer<typeof streamEventTypeSchema>;
export type StreamErrorCode = z.infer<typeof streamErrorCodeSchema>;
export type TurnStreamEvent<TData = unknown> = z.infer<
  typeof turnStreamEventSchema
> & { data: TData };
export type MessageEventData = z.infer<typeof messageEventDataSchema>;
export type DeltaEventData = z.infer<typeof deltaEventDataSchema>;
export type DoneEventData = z.infer<typeof doneEventDataSchema>;
export type ErrorEventData = z.infer<typeof errorEventDataSchema>;
export type RedactedEventData = z.infer<typeof redactedEventDataSchema>;
export type CreateTurnRequest = z.infer<typeof createTurnRequestSchema>;
export type CreateTurnResponse = z.infer<typeof createTurnResponseSchema>;
export type CancelTurnResponse = z.infer<typeof cancelTurnResponseSchema>;

export * from "./persona-schemas.js";
