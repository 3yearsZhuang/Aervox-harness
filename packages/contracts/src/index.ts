/**
 * Aervox｜思隅 @aervox/contracts
 *
 * 对话流式协议（Turn/SSE）的机器可验证契约事实源。
 * 模式见 schemas.ts，OpenAPI 文档见 openapi.ts，规则依据 docs/reference/STREAMING_PROTOCOL.md。
 */
import { z } from "zod";
import {
  cancelTurnResponseSchema,
  createLearningGoalSchema,
  createTurnRequestSchema,
  createTurnResponseSchema,
  deltaEventDataSchema,
  doneEventDataSchema,
  emoteEventDataSchema,
  errorEventDataSchema,
  learningGoalLevelSchema,
  learningGoalStatusSchema,
  memoryStoreToolInputSchema,
  memoryStoreToolOutputSchema,
  messageEventDataSchema,
  petCommandSchema,
  petCommandTypeSchema,
  petEmoteSchema,
  petGestureSchema,
  petManifestSchema,
  petSheetLayoutSchema,
  petSheetRowFramesSchema,
  petSheetStateSchema,
  pluginMetadataSchema,
  redactedEventDataSchema,
  streamErrorCodeSchema,
  streamEventTypeSchema,
  toolCategorySchema,
  toolGatingConditionSchema,
  toolGatingOperatorSchema,
  toolMetadataSchema,
  toolRegistryEntrySchema,
  toolRegistryExportSchema,
  toolSafetyLevelSchema,
  turnStatusSchema,
  updateLearningGoalSchema,
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
export type EmoteEventData = z.infer<typeof emoteEventDataSchema>;
export type PetCommand = z.infer<typeof petCommandSchema>;
export type PetCommandType = z.infer<typeof petCommandTypeSchema>;
export type PetEmote = z.infer<typeof petEmoteSchema>;
export type PetGesture = z.infer<typeof petGestureSchema>;
export type CreateTurnRequest = z.infer<typeof createTurnRequestSchema>;
export type CreateTurnResponse = z.infer<typeof createTurnResponseSchema>;
export type CancelTurnResponse = z.infer<typeof cancelTurnResponseSchema>;
export type LearningGoalLevel = z.infer<typeof learningGoalLevelSchema>;
export type LearningGoalStatus = z.infer<typeof learningGoalStatusSchema>;
export type CreateLearningGoal = z.infer<typeof createLearningGoalSchema>;
export type UpdateLearningGoal = z.infer<typeof updateLearningGoalSchema>;
export type ToolCategory = z.infer<typeof toolCategorySchema>;
export type ToolGatingOperator = z.infer<typeof toolGatingOperatorSchema>;
export type ToolGatingCondition = z.infer<typeof toolGatingConditionSchema>;
export type ToolSafetyLevel = z.infer<typeof toolSafetyLevelSchema>;
export type ToolMetadata = z.infer<typeof toolMetadataSchema>;
export type ToolRegistryEntry = z.infer<typeof toolRegistryEntrySchema>;
export type ToolRegistryExport = z.infer<typeof toolRegistryExportSchema>;
export type MemoryStoreToolInput = z.infer<typeof memoryStoreToolInputSchema>;
export type MemoryStoreToolOutput = z.infer<typeof memoryStoreToolOutputSchema>;
export type PluginMetadata = z.infer<typeof pluginMetadataSchema>;
export type PetSheetState = z.infer<typeof petSheetStateSchema>;
export type PetSheetLayout = z.infer<typeof petSheetLayoutSchema>;
export type PetManifest = z.infer<typeof petManifestSchema>;
export type PetSheetRowFrames = z.infer<typeof petSheetRowFramesSchema>;
