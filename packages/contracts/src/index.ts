/**
 * Aervox｜思隅 @aervox/contracts
 *
 * 对话流式协议（Turn/SSE）的机器可验证契约事实源。
 * 模式见 schemas.ts，OpenAPI 文档见 openapi.ts，规则依据 docs/reference/STREAMING_PROTOCOL.md。
 */
import { z } from "zod";
import {
  allowedMediaTypesSchema,
  attachmentPurposeSchema,
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
  diarySchema,
  diaryWriteToolInputSchema,
  diaryWriteToolOutputSchema,
  diaryListResponseSchema,
  diaryGenerateTodayOutputSchema,
  toolApprovalRequiredEventDataSchema,
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
  reasoningDeltaEventDataSchema,
  redactedEventDataSchema,
  turnAttachmentRefSchema,
  askUserQuestionOptionSchema,
  askUserQuestionIntentSchema,
  askUserQuestionItemSchema,
  userQuestionRequiredEventDataSchema,
  askUserQuestionAnswerItemSchema,
  userQuestionAnsweredEventDataSchema,
  submitQuestionAnswersRequestSchema,
  submitQuestionAnswersResponseSchema,
  skillCandidateCreateSchema,
  skillCandidateSchema,
  skillCandidateStatusSchema,
  skillEvaluationSchema,
  skillInstallRequestSchema,
  skillMetadataSchema,
  skillNameSchema,
  skillPayloadCreateSchema,
  skillPayloadSchema,
  skillPromoteRequestSchema,
  skillReleaseSchema,
  skillSourceEvidenceSchema,
  skillSourceSchema,
  skillStageSchema,
  skillDescriptorSchema,
  streamErrorCodeSchema,
  streamEventTypeSchema,
  toolCategorySchema,
  toolGatingConditionSchema,
  toolGatingOperatorSchema,
  toolMetadataSchema,
  toolRegistryEntrySchema,
  toolRegistryExportSchema,
  toolApprovalModeSchema,
  toolSafetyLevelSchema,
  turnStatusSchema,
  updateLearningGoalSchema,
  turnStreamEventSchema,
  extractedTermSchema,
  termsExtractedEventDataSchema,
  termExploreKindSchema,
  termExploreRequestSchema,
  termExploreResponseSchema,
} from "./schemas.js";
import {
  pluginConfigFieldSchema,
  pluginConfigSnapshotSchema,
  pluginConfigUpdateRequestSchema,
  pluginManifestSchema,
  pluginPageContextSchema,
  pluginPageSchema,
} from "./plugin-config-schemas.js";

export * from "./schemas.js";
export * from "./persona-schemas.js";
export * from "./plugin-config-schemas.js";
export * from "./practice-schemas.js";
export * from "./llm-schemas.js";
export * from "./inbox-schemas.js";
export * from "./proactive.js";
export * from "./proactive-schemas.js";
export { openApiDocument } from "./openapi.js";

export type TurnStatus = z.infer<typeof turnStatusSchema>;
export type StreamEventType = z.infer<typeof streamEventTypeSchema>;
export type StreamErrorCode = z.infer<typeof streamErrorCodeSchema>;
export type TurnStreamEvent<TData = unknown> = z.infer<
  typeof turnStreamEventSchema
> & { data: TData };
export type MessageEventData = z.infer<typeof messageEventDataSchema>;
export type DeltaEventData = z.infer<typeof deltaEventDataSchema>;
export type ReasoningDeltaEventData = z.infer<typeof reasoningDeltaEventDataSchema>;
export type DoneEventData = z.infer<typeof doneEventDataSchema>;
export type ErrorEventData = z.infer<typeof errorEventDataSchema>;
export type RedactedEventData = z.infer<typeof redactedEventDataSchema>;
export type AskUserQuestionOption = z.infer<typeof askUserQuestionOptionSchema>;
export type AskUserQuestionIntent = z.infer<typeof askUserQuestionIntentSchema>;
export type AskUserQuestionItem = z.infer<typeof askUserQuestionItemSchema>;
export type UserQuestionRequiredEventData = z.infer<typeof userQuestionRequiredEventDataSchema>;
export type AskUserQuestionAnswerItem = z.infer<typeof askUserQuestionAnswerItemSchema>;
export type UserQuestionAnsweredEventData = z.infer<typeof userQuestionAnsweredEventDataSchema>;
export type SubmitQuestionAnswersRequest = z.infer<typeof submitQuestionAnswersRequestSchema>;
export type SubmitQuestionAnswersResponse = z.infer<typeof submitQuestionAnswersResponseSchema>;
export type EmoteEventData = z.infer<typeof emoteEventDataSchema>;
export type PetCommand = z.infer<typeof petCommandSchema>;
export type PetCommandType = z.infer<typeof petCommandTypeSchema>;
export type PetEmote = z.infer<typeof petEmoteSchema>;
export type PetGesture = z.infer<typeof petGestureSchema>;
export type CreateTurnRequest = z.infer<typeof createTurnRequestSchema>;
export type TurnAttachmentRef = z.infer<typeof turnAttachmentRefSchema>;
export type AttachmentMediaType = z.infer<typeof allowedMediaTypesSchema>;
export type AttachmentPurpose = z.infer<typeof attachmentPurposeSchema>;
export type CreateTurnResponse = z.infer<typeof createTurnResponseSchema>;
export type CancelTurnResponse = z.infer<typeof cancelTurnResponseSchema>;
export type LearningGoalLevel = z.infer<typeof learningGoalLevelSchema>;
export type LearningGoalStatus = z.infer<typeof learningGoalStatusSchema>;
export type CreateLearningGoal = z.infer<typeof createLearningGoalSchema>;
export type UpdateLearningGoal = z.infer<typeof updateLearningGoalSchema>;
export type ToolCategory = z.infer<typeof toolCategorySchema>;
export type ToolGatingOperator = z.infer<typeof toolGatingOperatorSchema>;
export type ToolGatingCondition = z.infer<typeof toolGatingConditionSchema>;
export type ToolApprovalMode = z.infer<typeof toolApprovalModeSchema>;
export type ToolSafetyLevel = z.infer<typeof toolSafetyLevelSchema>;
export type ExtractedTerm = z.infer<typeof extractedTermSchema>;
export type TermsExtractedEventData = z.infer<typeof termsExtractedEventDataSchema>;
export type TermExploreKind = z.infer<typeof termExploreKindSchema>;
export type TermExploreRequest = z.infer<typeof termExploreRequestSchema>;
export type TermExploreResponse = z.infer<typeof termExploreResponseSchema>;
export type ToolMetadata = z.infer<typeof toolMetadataSchema>;
export type ToolRegistryEntry = z.infer<typeof toolRegistryEntrySchema>;
export type ToolRegistryExport = z.infer<typeof toolRegistryExportSchema>;
export type MemoryStoreToolInput = z.infer<typeof memoryStoreToolInputSchema>;
export type MemoryStoreToolOutput = z.infer<typeof memoryStoreToolOutputSchema>;
export type Diary = z.infer<typeof diarySchema>;
export type DiaryWriteToolInput = z.infer<typeof diaryWriteToolInputSchema>;
export type DiaryWriteToolOutput = z.infer<typeof diaryWriteToolOutputSchema>;
export type DiaryListResponse = z.infer<typeof diaryListResponseSchema>;
export type DiaryGenerateTodayOutput = z.infer<typeof diaryGenerateTodayOutputSchema>;
export type ToolApprovalRequiredEventData = z.infer<typeof toolApprovalRequiredEventDataSchema>;
export type PluginMetadata = z.infer<typeof pluginMetadataSchema>;
export type PluginConfigField = z.infer<typeof pluginConfigFieldSchema>;
export type PluginConfigSnapshot = z.infer<typeof pluginConfigSnapshotSchema>;
export type PluginConfigUpdateRequest = z.infer<typeof pluginConfigUpdateRequestSchema>;
export type PluginPage = z.infer<typeof pluginPageSchema>;
export type PluginManifest = z.infer<typeof pluginManifestSchema>;
export type PluginPageContext = z.infer<typeof pluginPageContextSchema>;
export type PetSheetState = z.infer<typeof petSheetStateSchema>;
export type PetSheetLayout = z.infer<typeof petSheetLayoutSchema>;
export type PetManifest = z.infer<typeof petManifestSchema>;
export type PetSheetRowFrames = z.infer<typeof petSheetRowFramesSchema>;
export type SkillSource = z.infer<typeof skillSourceSchema>;
export type SkillName = z.infer<typeof skillNameSchema>;
export type SkillStage = z.infer<typeof skillStageSchema>;
export type SkillCandidateStatus = z.infer<typeof skillCandidateStatusSchema>;
export type SkillMetadata = z.infer<typeof skillMetadataSchema>;
export type SkillDescriptor = z.infer<typeof skillDescriptorSchema>;
export type SkillInstallRequest = z.infer<typeof skillInstallRequestSchema>;
export type SkillPayload = z.infer<typeof skillPayloadSchema>;
export type SkillPayloadCreate = z.infer<typeof skillPayloadCreateSchema>;
export type SkillSourceEvidence = z.infer<typeof skillSourceEvidenceSchema>;
export type SkillCandidate = z.infer<typeof skillCandidateSchema>;
export type SkillCandidateCreate = z.infer<typeof skillCandidateCreateSchema>;
export type SkillEvaluation = z.infer<typeof skillEvaluationSchema>;
export type SkillRelease = z.infer<typeof skillReleaseSchema>;
export type SkillPromoteRequest = z.infer<typeof skillPromoteRequestSchema>;
