/**
 * Aervox｜思隅 @aervox/contracts — OpenAPI 3.1 文档生成
 *
 * 由 Zod 模式（schemas.ts）生成，作为流式协议机器可验证契约。
 * 规则依据：docs/reference/STREAMING_PROTOCOL.md（AVX-SPC-001）。
 */
import { z } from "zod";
import type { OpenAPIObject } from "openapi3-ts/oas31";
import {
  OpenAPIRegistry,
  OpenApiGeneratorV31,
} from "@asteasolutions/zod-to-openapi";
import {
  cancelTurnResponseSchema,
  createLearningGoalSchema,
  createTurnRequestSchema,
  createTurnResponseSchema,
  deltaEventDataSchema,
  doneEventDataSchema,
  emoteEventDataSchema,
  errorEventDataSchema,
  memoryStoreToolInputSchema,
  memoryStoreToolOutputSchema,
  diarySchema,
  diaryWriteToolInputSchema,
  diaryWriteToolOutputSchema,
  diaryListResponseSchema,
  diaryGenerateTodayOutputSchema,
  toolApprovalRequiredEventDataSchema,
  messageEventDataSchema,
  reasoningDeltaEventDataSchema,
  petCommandSchema,
  petManifestSchema,
  petSheetLayoutSchema,
  petSheetStateSchema,
  redactedEventDataSchema,
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
  skillEvaluationSchema,
  skillInstallRequestSchema,
  skillMetadataSchema,
  skillPayloadCreateSchema,
  skillPayloadSchema,
  skillPromoteRequestSchema,
  skillReleaseSchema,
  streamErrorCodeSchema,
  toolMetadataSchema,
  toolRegistryEntrySchema,
  toolRegistryExportSchema,
  turnStreamEventSchema,
  updateLearningGoalSchema,
  createPracticeReportSchema,
  generateLearningPlanSchema,
  updatePlanTaskStatusSchema,
  practiceReportResponseSchema,
  practiceReportListResponseSchema,
  learningPlanResponseSchema,
  learningPlanListResponseSchema,
  extractedTermSchema,
  termsExtractedEventDataSchema,
  termExploreRequestSchema,
  termExploreResponseSchema,
} from "./schemas.js";
import {
  activatePersonaRequestSchema,
  activePersonaSelectionSchema,
  createPersonaRequestSchema,
  exportSkillsRequestSchema,
  importPersonaRequestSchema,
  importSkillsRequestSchema,
  localVoiceConfigResponseSchema,
  localVoiceConfigSchema,
  mcpToolSchema,
  personaBundleResponseSchema,
  personaRevisionSchema,
  personaSchema,
  skillSummarySchema,
  skillZipResponseSchema,
  updatePersonaRequestSchema,
  voiceModelSchema,
  voiceSynthesisRequestSchema,
  voiceSynthesisResponseSchema,
  voiceInputConfigSchema,
  voiceInputConfigResponseSchema,
  voiceTranscribeRequestSchema,
  voiceTranscribeResponseSchema,
  voiceInputModelStatusSchema,
  voiceInputModelDownloadRequestSchema,
  voiceInputModelDownloadResponseSchema,
} from "./persona-schemas.js";
import {
  pluginConfigSchemaOpenApi,
  pluginConfigSnapshotSchema,
  pluginConfigUpdateRequestSchema,
  pluginPageAssetsRequestSchema,
  pluginPageSchema,
  pluginManifestSchema,
  pluginPageContextSchema,
} from "./plugin-config-schemas.js";
import {
  createAttemptRequestSchema,
  createPracticeSessionRequestSchema,
  createPracticeSessionResponseSchema,
  practiceSessionResumeResponseSchema,
  mistakeItemSchema,
  mistakeListResponseSchema,
  mistakeReasonCodeSchema,
  mistakeStatusEnumSchema,
  practiceQuestionSchema,
  practiceReportSchema,
  repracticeRequestSchema,
  updateMistakeRequestSchema,
  completeReviewRequestSchema,
  completeReviewResponseSchema,
  reviewItemSchema,
  reviewHistoryResponseSchema,
  reviewListResponseSchema,
  reviewSummaryResponseSchema,
} from "./practice-schemas.js";

import {
  llmConfigResponseSchema,
  llmConfigSchema,
  llmTestConnectionRequestSchema,
  llmTestConnectionResponseSchema,
} from "./llm-schemas.js";

import {
  createInboxItemRequestSchema,
  inboxItemResponseSchema,
} from "./inbox-schemas.js";
import {
  homeAssistantCallServiceSchema,
  homeAssistantConnectionRequestSchema,
  homeAssistantEntityPatchSchema,
  proactiveActionRequestSchema,
  proactiveActivationRequestSchema,
  proactiveAuthorizeRequestSchema,
  proactiveCaptureRequestSchema,
  proactiveClaimRequestSchema,
  proactiveDesiredStateRequestSchema,
  proactiveExportRequestSchema,
  proactiveExportResponseSchema,
  proactiveConnectionResponseSchema,
  proactiveIntelligenceDashboardSchema,
  proactiveObservationRequestSchema,
  proactiveSyncDateSchema,
  proactiveSourceGrantInputSchema,
  proactiveStatusResponseSchema,
  xiaomiHealthConnectionRequestSchema,
} from "./proactive-schemas.js";

const registry = new OpenAPIRegistry();

registry.register("CreateLearningGoal", createLearningGoalSchema);
registry.register("UpdateLearningGoal", updateLearningGoalSchema);
registry.register("CreateTurnRequest", createTurnRequestSchema);
registry.register("CreateTurnResponse", createTurnResponseSchema);
registry.register("CancelTurnResponse", cancelTurnResponseSchema);
registry.register("TurnStreamEvent", turnStreamEventSchema);
registry.register("MessageEventData", messageEventDataSchema);
registry.register("DeltaEventData", deltaEventDataSchema);
registry.register("ReasoningDeltaEventData", reasoningDeltaEventDataSchema);
registry.register("DoneEventData", doneEventDataSchema);
registry.register("ErrorEventData", errorEventDataSchema);
registry.register("RedactedEventData", redactedEventDataSchema);
registry.register("PetCommand", petCommandSchema);
registry.register("EmoteEventData", emoteEventDataSchema);
registry.register("StreamErrorCode", streamErrorCodeSchema);
registry.register("ToolMetadata", toolMetadataSchema);
registry.register("ToolRegistryEntry", toolRegistryEntrySchema);
registry.register("ToolRegistryExport", toolRegistryExportSchema);
registry.register("MemoryStoreToolInput", memoryStoreToolInputSchema);
registry.register("MemoryStoreToolOutput", memoryStoreToolOutputSchema);
registry.register("Diary", diarySchema);
registry.register("DiaryWriteToolInput", diaryWriteToolInputSchema);
registry.register("DiaryWriteToolOutput", diaryWriteToolOutputSchema);
registry.register("DiaryListResponse", diaryListResponseSchema);
registry.register("DiaryGenerateTodayOutput", diaryGenerateTodayOutputSchema);
registry.register("ToolApprovalRequiredEventData", toolApprovalRequiredEventDataSchema);
registry.register("PetSheetState", petSheetStateSchema);
registry.register("PetSheetLayout", petSheetLayoutSchema);
registry.register("PetManifest", petManifestSchema);
registry.register("Persona", personaSchema);
registry.register("PersonaRevision", personaRevisionSchema);
registry.register("ActivePersonaSelection", activePersonaSelectionSchema);
registry.register("CreatePersonaRequest", createPersonaRequestSchema);
registry.register("UpdatePersonaRequest", updatePersonaRequestSchema);
registry.register("SkillSummary", skillSummarySchema);
registry.register("McpTool", mcpToolSchema);
registry.register("VoiceModel", voiceModelSchema);
registry.register("VoiceSynthesisRequest", voiceSynthesisRequestSchema);
registry.register("VoiceSynthesisResponse", voiceSynthesisResponseSchema);
registry.register("LocalVoiceConfig", localVoiceConfigSchema);
registry.register("LocalVoiceConfigResponse", localVoiceConfigResponseSchema);
registry.register("PersonaBundleResponse", personaBundleResponseSchema);
registry.register("SkillZipResponse", skillZipResponseSchema);
registry.register("SkillMetadata", skillMetadataSchema);
registry.register("SkillInstallRequest", skillInstallRequestSchema);
registry.register("SkillPayload", skillPayloadSchema);
registry.register("SkillPayloadCreate", skillPayloadCreateSchema);
registry.register("SkillCandidate", skillCandidateSchema);
registry.register("SkillCandidateCreate", skillCandidateCreateSchema);
registry.register("SkillEvaluation", skillEvaluationSchema);
registry.register("SkillRelease", skillReleaseSchema);
registry.register("SkillPromoteRequest", skillPromoteRequestSchema);

registry.register("PluginConfigSchema", pluginConfigSchemaOpenApi);
registry.register("PluginConfigSnapshot", pluginConfigSnapshotSchema);
registry.register("PluginConfigUpdateRequest", pluginConfigUpdateRequestSchema);
registry.register("PluginPage", pluginPageSchema);
registry.register("PluginPageAssetsRequest", pluginPageAssetsRequestSchema);
registry.register("PluginManifest", pluginManifestSchema);
registry.register("PluginPageContext", pluginPageContextSchema);

registry.register("PracticeQuestion", practiceQuestionSchema);
registry.register("CreatePracticeSessionRequest", createPracticeSessionRequestSchema);
registry.register("CreatePracticeSessionResponse", createPracticeSessionResponseSchema);
registry.register("PracticeSessionResumeResponse", practiceSessionResumeResponseSchema);
registry.register("PracticeReport", practiceReportSchema);
registry.register("MistakeItem", mistakeItemSchema);
registry.register("MistakeListResponse", mistakeListResponseSchema);
registry.register("UpdateMistakeRequest", updateMistakeRequestSchema);
registry.register("RepracticeRequest", repracticeRequestSchema);
registry.register("CreateAttemptRequest", createAttemptRequestSchema);
registry.register("ReviewItem", reviewItemSchema);
registry.register("ReviewHistoryResponse", reviewHistoryResponseSchema);
registry.register("ReviewListResponse", reviewListResponseSchema);
registry.register("ReviewSummaryResponse", reviewSummaryResponseSchema);
registry.register("CompleteReviewRequest", completeReviewRequestSchema);
registry.register("CompleteReviewResponse", completeReviewResponseSchema);

registry.register("LLMConfig", llmConfigSchema);
registry.register("LLMConfigResponse", llmConfigResponseSchema);
registry.register("LLMTestConnectionRequest", llmTestConnectionRequestSchema);
registry.register("LLMTestConnectionResponse", llmTestConnectionResponseSchema);

registry.register("VoiceInputConfig", voiceInputConfigSchema);
registry.register("VoiceInputConfigResponse", voiceInputConfigResponseSchema);
registry.register("VoiceTranscribeRequest", voiceTranscribeRequestSchema);
registry.register("VoiceTranscribeResponse", voiceTranscribeResponseSchema);
registry.register("VoiceInputModelStatus", voiceInputModelStatusSchema);
registry.register("VoiceInputModelDownloadRequest", voiceInputModelDownloadRequestSchema);
registry.register("VoiceInputModelDownloadResponse", voiceInputModelDownloadResponseSchema);

registry.register("CreateInboxItemRequest", createInboxItemRequestSchema);
registry.register("InboxItem", inboxItemResponseSchema);
registry.register("ProactiveSourceGrantInput", proactiveSourceGrantInputSchema);
registry.register("ProactiveAuthorizeRequest", proactiveAuthorizeRequestSchema);
registry.register("ProactiveDesiredStateRequest", proactiveDesiredStateRequestSchema);
registry.register("ProactiveActivationRequest", proactiveActivationRequestSchema);
registry.register("ProactiveCaptureRequest", proactiveCaptureRequestSchema);
registry.register("ProactiveObservationRequest", proactiveObservationRequestSchema);
registry.register("ProactiveClaimRequest", proactiveClaimRequestSchema);
registry.register("ProactiveActionRequest", proactiveActionRequestSchema);
registry.register("ProactiveExportRequest", proactiveExportRequestSchema);
registry.register("ProactiveStatusResponse", proactiveStatusResponseSchema);
registry.register("ProactiveExportResponse", proactiveExportResponseSchema);
registry.register("ProactiveConnectionResponse", proactiveConnectionResponseSchema);
registry.register("ProactiveIntelligenceDashboard", proactiveIntelligenceDashboardSchema);
registry.register("HomeAssistantConnectionRequest", homeAssistantConnectionRequestSchema);
registry.register("HomeAssistantEntityPatch", homeAssistantEntityPatchSchema);
registry.register("HomeAssistantCallService", homeAssistantCallServiceSchema);
registry.register("XiaomiHealthConnectionRequest", xiaomiHealthConnectionRequestSchema);

const sessionIdParam = z.object({ sessionId: z.string().min(1) });
const turnIdParam = z.object({ turnId: z.string().min(1) });
const scopeHeaders = z.object({
  "X-Workspace-Id": z.string().min(1).optional(),
  "X-User-Id": z.string().min(1).optional(),
  "X-Actor-Id": z.string().min(1).optional(),
});

registry.registerPath({
  method: "get",
  path: "/v1/diaries",
  summary: "按本地日期查询日记",
  tags: ["Diary"],
  request: {
    query: z.object({ localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    headers: scopeHeaders,
  },
  responses: {
    200: {
      description: "Diary of the local date",
      content: { "application/json": { schema: diarySchema } },
    },
    400: { description: "localDate is required (YYYY-MM-DD)" },
    404: { description: "Diary not found" },
  },
});
const proactiveHeaders = scopeHeaders.extend({
  "X-Aervox-Proactive-Token": z.string().min(32),
});
const proactiveSourceGrantIdParam = z.object({ sourceGrantId: z.string().min(1) });
const proactiveConnectionIdParam = z.object({ id: z.string().min(1) });
const proactiveHomeEntityParam = z.object({ id: z.string().min(1), entityId: z.string().min(3) });

registry.registerPath({
  method: "post",
  path: "/v1/sessions/{sessionId}/turns",
  summary: "创建 Turn（幂等）",
  tags: ["Turn"],
  request: {
    params: sessionIdParam,
    headers: z.object({ "Idempotency-Key": z.string().min(1) }),
    body: {
      content: {
        "application/json": { schema: createTurnRequestSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: createTurnResponseSchema } },
    },
    400: {
      description: "Invalid request",
      content: { "application/json": { schema: errorEventDataSchema } },
    },
    409: {
      description: "IDEMPOTENCY_KEY_REUSED",
      content: { "application/json": { schema: errorEventDataSchema } },
    },
  },
});

registry.registerPath({
  method: "get",
  path: "/v1/proactive/status",
  summary: "读取主动智能授权与本地运行状态",
  tags: ["Proactive"],
  request: { headers: proactiveHeaders },
  responses: { 200: { description: "Proactive status", content: { "application/json": { schema: proactiveStatusResponseSchema } } } },
});
registry.registerPath({
  method: "get",
  path: "/v1/proactive/manifest",
  summary: "读取 full_profile_v1 来源与保留策略",
  tags: ["Proactive"],
  request: { headers: proactiveHeaders },
  responses: { 200: { description: "Full profile manifest" } },
});
registry.registerPath({
  method: "post",
  path: "/v1/proactive/authorize",
  summary: "原子确认全量画像与动作授权包",
  tags: ["Proactive"],
  request: { headers: proactiveHeaders, body: { content: { "application/json": { schema: proactiveAuthorizeRequestSchema } } } },
  responses: { 201: { description: "Profile revision confirmed" }, 400: { description: "Invalid grant" }, 409: { description: "full_access required" } },
});
registry.registerPath({
  method: "post",
  path: "/v1/proactive/desired-state",
  summary: "暂停、恢复或撤销主动智能模式",
  tags: ["Proactive"],
  request: { headers: proactiveHeaders, body: { content: { "application/json": { schema: proactiveDesiredStateRequestSchema } } } },
  responses: { 200: { description: "Desired state updated" }, 404: { description: "Profile revision not found" } },
});
registry.registerPath({
  method: "post",
  path: "/v1/proactive/activation",
  summary: "创建设备级本地激活租约",
  tags: ["Proactive"],
  request: { headers: proactiveHeaders, body: { content: { "application/json": { schema: proactiveActivationRequestSchema } } } },
  responses: { 201: { description: "Activation lease created" } },
});
registry.registerPath({
  method: "delete",
  path: "/v1/proactive/sources/{sourceGrantId}/data",
  summary: "撤销来源并删除本地捕获、观察和画像证据",
  tags: ["Proactive"],
  request: { headers: proactiveHeaders, params: proactiveSourceGrantIdParam },
  responses: { 200: { description: "Source data deleted" }, 404: { description: "Source grant not found" } },
});
registry.registerPath({
  method: "post",
  path: "/v1/proactive/captures",
  summary: "写入加密原始捕获副本",
  tags: ["Proactive"],
  request: { headers: proactiveHeaders, body: { content: { "application/json": { schema: proactiveCaptureRequestSchema } } } },
  responses: { 201: { description: "Capture accepted without echoing raw payload" } },
});
registry.registerPath({
  method: "post",
  path: "/v1/proactive/observations",
  summary: "写入本地规范化行为观察",
  tags: ["Proactive"],
  request: { headers: proactiveHeaders, body: { content: { "application/json": { schema: proactiveObservationRequestSchema } } } },
  responses: { 201: { description: "Observation created" } },
});
registry.registerPath({
  method: "post",
  path: "/v1/proactive/claims",
  summary: "写入带证据的本地画像声明",
  tags: ["Proactive"],
  request: { headers: proactiveHeaders, body: { content: { "application/json": { schema: proactiveClaimRequestSchema } } } },
  responses: { 201: { description: "Profile claim created" } },
});
registry.registerPath({
  method: "post",
  path: "/v1/proactive/actions",
  summary: "写入主动动作请求与授权修订",
  tags: ["Proactive"],
  request: { headers: proactiveHeaders, body: { content: { "application/json": { schema: proactiveActionRequestSchema } } } },
  responses: { 201: { description: "Proactive action created" } },
});
registry.registerPath({
  method: "post",
  path: "/v1/proactive/export",
  summary: "显式导出本地主动画像数据",
  tags: ["Proactive"],
  request: { headers: proactiveHeaders, body: { content: { "application/json": { schema: proactiveExportRequestSchema } } } },
  responses: { 200: { description: "Checksummed export", content: { "application/json": { schema: proactiveExportResponseSchema } } } },
});
registry.registerPath({
  method: "get",
  path: "/v1/proactive/intelligence/dashboard",
  summary: "读取十二项主动智能能力的本地仪表盘",
  tags: ["Proactive Intelligence"],
  request: {headers: proactiveHeaders},
  responses: {200: {description: "Local intelligence dashboard", content: {"application/json": {schema: proactiveIntelligenceDashboardSchema}}}},
});
registry.registerPath({
  method: "get",
  path: "/v1/proactive/integrations",
  summary: "列出已配置的本地外部连接（不返回凭据）",
  tags: ["Proactive Integrations"],
  request: {headers: proactiveHeaders},
  responses: {200: {description: "Redacted integration list", content: {"application/json": {schema: z.object({items: z.array(proactiveConnectionResponseSchema)})}}}},
});
registry.registerPath({
  method: "post",
  path: "/v1/proactive/integrations/home-assistant",
  summary: "连接并同步 Home Assistant",
  tags: ["Proactive Integrations"],
  request: {headers: proactiveHeaders, body: {content: {"application/json": {schema: homeAssistantConnectionRequestSchema}}}},
  responses: {201: {description: "Home Assistant connected"}, 400: {description: "Connection or endpoint validation failed"}, 403: {description: "device.sensors grant is not active"}},
});
registry.registerPath({
  method: "post",
  path: "/v1/proactive/integrations/home-assistant/{id}/sync",
  summary: "同步 Home Assistant 实体目录并恢复事件订阅",
  tags: ["Proactive Integrations"],
  request: {headers: proactiveHeaders, params: proactiveConnectionIdParam},
  responses: {200: {description: "Home Assistant synchronized"}},
});
registry.registerPath({
  method: "patch",
  path: "/v1/proactive/integrations/home-assistant/{id}/entities/{entityId}",
  summary: "更新 Home Assistant 实体和服务白名单",
  tags: ["Proactive Integrations"],
  request: {headers: proactiveHeaders, params: proactiveHomeEntityParam, body: {content: {"application/json": {schema: homeAssistantEntityPatchSchema}}}},
  responses: {200: {description: "Entity authorization updated"}, 404: {description: "Entity not found"}},
});
registry.registerPath({
  method: "post",
  path: "/v1/proactive/integrations/home-assistant/{id}/call-service",
  summary: "在主动动作授权与实体白名单内调用 Home Assistant 服务",
  tags: ["Proactive Integrations"],
  request: {headers: proactiveHeaders, params: proactiveConnectionIdParam, body: {content: {"application/json": {schema: homeAssistantCallServiceSchema}}}},
  responses: {200: {description: "Service called and action audited"}, 403: {description: "Action, entity, or service is not authorized"}},
});
registry.registerPath({
  method: "delete",
  path: "/v1/proactive/integrations/home-assistant/{id}",
  summary: "撤销 Home Assistant 并删除本地凭据和缓存",
  tags: ["Proactive Integrations"],
  request: {headers: proactiveHeaders, params: proactiveConnectionIdParam},
  responses: {204: {description: "Connection removed"}, 404: {description: "Connection not found"}},
});
registry.registerPath({
  method: "post",
  path: "/v1/proactive/integrations/xiaomi-health",
  summary: "连接并同步小米运动健康每日汇总",
  tags: ["Proactive Integrations"],
  request: {headers: proactiveHeaders, body: {content: {"application/json": {schema: xiaomiHealthConnectionRequestSchema}}}},
  responses: {201: {description: "Xiaomi Health connected"}, 400: {description: "Provider configuration or connection validation failed"}, 403: {description: "restricted.profile grant is not active"}},
});
registry.registerPath({
  method: "post",
  path: "/v1/proactive/integrations/xiaomi-health/{id}/sync",
  summary: "同步指定日期的小米运动健康汇总",
  tags: ["Proactive Integrations"],
  request: {headers: proactiveHeaders, params: proactiveConnectionIdParam, body: {content: {"application/json": {schema: proactiveSyncDateSchema}}}},
  responses: {200: {description: "Health data synchronized"}},
});
registry.registerPath({
  method: "delete",
  path: "/v1/proactive/integrations/xiaomi-health/{id}",
  summary: "撤销小米运动健康并删除本地凭据和样本",
  tags: ["Proactive Integrations"],
  request: {headers: proactiveHeaders, params: proactiveConnectionIdParam},
  responses: {204: {description: "Connection removed"}, 404: {description: "Connection not found"}},
});

registry.registerPath({
  method: "get",
  path: "/v1/turns/{turnId}/events",
  summary: "读取 Turn SSE 事件流",
  tags: ["Turn"],
  request: { params: turnIdParam },
  responses: {
    200: {
      description: "SSE event stream",
      content: { "text/event-stream": { schema: turnStreamEventSchema } },
    },
    404: { description: "TURN_NOT_FOUND" },
    410: { description: "STREAM_CURSOR_EXPIRED" },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/turns/{turnId}/cancel",
  summary: "取消 Turn",
  tags: ["Turn"],
  request: { params: turnIdParam },
  responses: {
    200: {
      description: "Cancelled",
      content: { "application/json": { schema: cancelTurnResponseSchema } },
    },
    404: { description: "TURN_NOT_FOUND" },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/turns/{turnId}/questions/answers",
  summary: "提交向用户询问的回答（UQ-01）",
  tags: ["Turn"],
  request: {
    params: turnIdParam,
    body: { content: { "application/json": { schema: submitQuestionAnswersRequestSchema } } },
  },
  responses: {
    200: {
      description: "Answers accepted and resumed",
      content: { "application/json": { schema: submitQuestionAnswersResponseSchema } },
    },
    400: { description: "Invalid answers request" },
    404: { description: "TURN_NOT_FOUND or no pending question" },
    409: { description: "Question already answered or turn finalized" },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/turns/{turnId}/tool-approvals",
  summary: "写工具授权决定（PET-05；granted 后由客户端重发相同请求命中授权）",
  tags: ["Turn"],
  request: {
    params: turnIdParam,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            approvalId: z.string().min(1),
            decision: z.enum(["granted", "denied"]),
            decidedBy: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: { description: "Decision recorded" },
    400: { description: "approvalId and decision (granted|denied) are required" },
    403: { description: "admin_required (privileged tool)" },
    404: { description: "Approval not found" },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/learning/goals",
  summary: "创建学习目标（FR-LRN-001）",
  tags: ["Learning"],
  request: {
    headers: z.object({ "Idempotency-Key": z.string().min(1).optional() }),
    body: { content: { "application/json": { schema: createLearningGoalSchema } } },
  },
  responses: {
    201: { description: "Created" },
    200: { description: "Existing idempotent result" },
    400: { description: "Invalid request（topic/availableMinutes 非法）" },
  },
});

const learningGoalIdParam = z.object({ goalId: z.string().min(1) });
const learningGoalListQuery = z.object({ includeArchived: z.enum(["true", "false"]).optional() });

registry.registerPath({
  method: "get",
  path: "/v1/learning/goals",
  summary: "列出学习目标",
  tags: ["Learning"],
  request: { query: learningGoalListQuery },
  responses: { 200: { description: "Learning goals" } },
});

registry.registerPath({
  method: "get",
  path: "/v1/learning/goals/{goalId}",
  summary: "读取学习目标",
  tags: ["Learning"],
  request: { params: learningGoalIdParam },
  responses: {
    200: { description: "Learning goal" },
    404: { description: "Goal not found" },
  },
});

registry.registerPath({
  method: "patch",
  path: "/v1/learning/goals/{goalId}",
  summary: "更新学习目标",
  tags: ["Learning"],
  request: {
    params: learningGoalIdParam,
    body: { content: { "application/json": { schema: updateLearningGoalSchema } } },
  },
  responses: {
    200: { description: "Updated" },
    400: { description: "Invalid request" },
    404: { description: "Goal not found" },
  },
});

registry.registerPath({
  method: "delete",
  path: "/v1/learning/goals/{goalId}",
  summary: "归档学习目标",
  tags: ["Learning"],
  request: { params: learningGoalIdParam },
  responses: {
    204: { description: "Archived" },
    404: { description: "Goal not found" },
  },
});

const personaIdParam = z.object({ personaId: z.string().min(1) });
const skillNameParam = z.object({ skillName: z.string().min(1) });
registry.registerPath({
  method: "get", path: "/v1/personas", summary: "列出人格", tags: ["Persona"],
  request: { headers: scopeHeaders },
  responses: { 200: { description: "Persona list", content: { "application/json": { schema: z.object({ personas: z.array(personaSchema), active: activePersonaSelectionSchema.nullable() }) } } } },
});
registry.registerPath({
  method: "post", path: "/v1/personas", summary: "创建人格", tags: ["Persona"],
  request: { headers: scopeHeaders, body: { content: { "application/json": { schema: createPersonaRequestSchema } } } },
  responses: { 201: { description: "Created", content: { "application/json": { schema: z.object({ persona: personaSchema, revision: personaRevisionSchema }) } } } },
});
registry.registerPath({
  method: "get", path: "/v1/personas/{personaId}", summary: "读取人格", tags: ["Persona"],
  request: { params: personaIdParam, headers: scopeHeaders },
  responses: { 200: { description: "Persona", content: { "application/json": { schema: z.object({ persona: personaSchema, revision: personaRevisionSchema, active: z.boolean() }) } } }, 404: { description: "PERSONA_NOT_FOUND" } },
});
registry.registerPath({
  method: "patch", path: "/v1/personas/{personaId}", summary: "创建人格新修订", tags: ["Persona"],
  request: { params: personaIdParam, headers: scopeHeaders, body: { content: { "application/json": { schema: updatePersonaRequestSchema } } } },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: z.object({ persona: personaSchema, revision: personaRevisionSchema }) } } }, 409: { description: "PERSONA_REVISION_CONFLICT" } },
});
registry.registerPath({
  method: "delete", path: "/v1/personas/{personaId}", summary: "归档人格", tags: ["Persona"],
  request: { params: personaIdParam, headers: scopeHeaders }, responses: { 200: { description: "Deleted" }, 404: { description: "PERSONA_NOT_FOUND" } },
});
registry.registerPath({
  method: "post", path: "/v1/personas/{personaId}/activate", summary: "激活人格", tags: ["Persona"],
  request: { params: personaIdParam, headers: scopeHeaders, body: { content: { "application/json": { schema: activatePersonaRequestSchema } } } },
  responses: { 200: { description: "Activated", content: { "application/json": { schema: activePersonaSelectionSchema } } } },
});
registry.registerPath({
  method: "post", path: "/v1/personas/{personaId}/export", summary: "导出人格及实际生效 Skills", tags: ["Persona"],
  request: { params: personaIdParam, headers: scopeHeaders }, responses: { 200: { description: "Base64 ZIP", content: { "application/json": { schema: personaBundleResponseSchema } } } },
});
registry.registerPath({
  method: "post", path: "/v1/personas/import/preview", summary: "预览人格 Bundle", tags: ["Persona"],
  request: { headers: scopeHeaders, body: { content: { "application/json": { schema: importPersonaRequestSchema } } } }, responses: { 200: { description: "Preview" }, 400: { description: "INVALID_BUNDLE" } },
});
registry.registerPath({
  method: "post", path: "/v1/personas/import", summary: "导入人格及 Skills", tags: ["Persona"],
  request: { headers: scopeHeaders, body: { content: { "application/json": { schema: importPersonaRequestSchema } } } }, responses: { 201: { description: "Imported" } },
});
registry.registerPath({
  method: "get", path: "/v1/skills", summary: "列出有效 Skills", tags: ["Skills"], request: { headers: scopeHeaders },
  responses: { 200: { description: "Skills", content: { "application/json": { schema: z.object({ skills: z.array(skillSummarySchema) }) } } } },
});
registry.registerPath({
  method: "post", path: "/v1/skills/import", summary: "导入 Anthropic Skills ZIP", tags: ["Skills"],
  request: { headers: scopeHeaders, body: { content: { "application/json": { schema: importSkillsRequestSchema } } } }, responses: { 201: { description: "Imported" } },
});
registry.registerPath({
  method: "post", path: "/v1/skills/export", summary: "导出 Skills ZIP", tags: ["Skills"],
  request: { headers: scopeHeaders, body: { content: { "application/json": { schema: exportSkillsRequestSchema } } } }, responses: { 200: { description: "Base64 ZIP", content: { "application/json": { schema: skillZipResponseSchema } } } },
});
for (const action of ["enable", "disable"] as const) registry.registerPath({
  method: "post", path: `/v1/skills/{skillName}/${action}`, summary: `${action} Skill`, tags: ["Skills"],
  request: { params: skillNameParam, headers: scopeHeaders }, responses: { 200: { description: "Skill", content: { "application/json": { schema: skillSummarySchema } } } },
});
registry.registerPath({ method: "delete", path: "/v1/skills/{skillName}", summary: "删除工作区 Skill", tags: ["Skills"], request: { params: skillNameParam, headers: scopeHeaders }, responses: { 200: { description: "Deleted" } } });
registry.registerPath({ method: "get", path: "/v1/mcp/tools", summary: "列出 MCP 工具", tags: ["MCP"], request: { headers: scopeHeaders }, responses: { 200: { description: "MCP tools", content: { "application/json": { schema: z.object({ tools: z.array(mcpToolSchema) }) } } } } });
registry.registerPath({ method: "get", path: "/v1/voice/models", summary: "列出 GPT-SoVITS 模型", tags: ["Voice"], responses: { 200: { description: "Voice models", content: { "application/json": { schema: z.object({ models: z.array(voiceModelSchema) }) } } } } });
registry.registerPath({ method: "post", path: "/v1/voice/synthesize", summary: "GPT-SoVITS 语音合成", tags: ["Voice"], request: { body: { content: { "application/json": { schema: voiceSynthesisRequestSchema } } } }, responses: { 200: { description: "Audio artifact", content: { "application/json": { schema: voiceSynthesisResponseSchema } } }, 503: { description: "VOICE_PROVIDER_UNAVAILABLE" } } });
registry.registerPath({ method: "get", path: "/v1/voice/config", summary: "读取本地语音模型配置", tags: ["Voice"], request: { headers: scopeHeaders }, responses: { 200: { description: "Local voice config", content: { "application/json": { schema: localVoiceConfigResponseSchema } } } } });
registry.registerPath({ method: "put", path: "/v1/voice/config", summary: "保存本地语音模型配置", tags: ["Voice"], request: { headers: scopeHeaders, body: { content: { "application/json": { schema: localVoiceConfigSchema } } } }, responses: { 200: { description: "Local voice config", content: { "application/json": { schema: localVoiceConfigResponseSchema } } }, 400: { description: "INVALID_VOICE_CONFIG / modelPath 不在白名单" }, 503: { description: "VOICE_PROVIDER_UNAVAILABLE" } } });

registry.registerPath({ method: "get", path: "/v1/voice/input/config", summary: "读取离线语音输入配置", tags: ["Voice"], request: { headers: scopeHeaders }, responses: { 200: { description: "Voice input config", content: { "application/json": { schema: voiceInputConfigResponseSchema } } } } });
registry.registerPath({ method: "put", path: "/v1/voice/input/config", summary: "保存离线语音输入配置", tags: ["Voice"], request: { headers: scopeHeaders, body: { content: { "application/json": { schema: voiceInputConfigSchema } } } }, responses: { 200: { description: "Voice input config", content: { "application/json": { schema: voiceInputConfigResponseSchema } } }, 400: { description: "INVALID_VOICE_INPUT_CONFIG / modelPath 不在白名单" } } });
registry.registerPath({ method: "get", path: "/v1/voice/input/model/status", summary: "读取离线语音输入模型下载与存在状态", tags: ["Voice"], request: { headers: scopeHeaders }, responses: { 200: { description: "Model status", content: { "application/json": { schema: voiceInputModelStatusSchema } } } } });
registry.registerPath({ method: "post", path: "/v1/voice/input/model/download", summary: "触发离线语音输入模型下载", tags: ["Voice"], request: { headers: scopeHeaders, body: { content: { "application/json": { schema: voiceInputModelDownloadRequestSchema } } } }, responses: { 200: { description: "Download started", content: { "application/json": { schema: voiceInputModelDownloadResponseSchema } } }, 400: { description: "INVALID_DOWNLOAD_REQUEST" } } });
registry.registerPath({ method: "post", path: "/v1/voice/transcribe", summary: "语音识别转写 (ASR)", tags: ["Voice"], request: { headers: scopeHeaders, body: { content: { "application/json": { schema: voiceTranscribeRequestSchema } } } }, responses: { 200: { description: "Transcription result", content: { "application/json": { schema: voiceTranscribeResponseSchema } } }, 400: { description: "INVALID_AUDIO" }, 503: { description: "VOICE_INPUT_PROVIDER_UNAVAILABLE" } } });

registry.registerPath({ method: "get", path: "/v1/llm/config", summary: "读取大语言模型与供应商配置", tags: ["LLM"], request: { headers: scopeHeaders }, responses: { 200: { description: "LLM config", content: { "application/json": { schema: llmConfigResponseSchema } } } } });
registry.registerPath({ method: "put", path: "/v1/llm/config", summary: "保存大语言模型与供应商配置", tags: ["LLM"], request: { headers: scopeHeaders, body: { content: { "application/json": { schema: llmConfigSchema } } } }, responses: { 200: { description: "LLM config", content: { "application/json": { schema: llmConfigResponseSchema } } }, 400: { description: "INVALID_LLM_CONFIG" } } });
registry.registerPath({ method: "post", path: "/v1/llm/test-connection", summary: "测试大模型供应商连通性", tags: ["LLM"], request: { headers: scopeHeaders, body: { content: { "application/json": { schema: llmTestConnectionRequestSchema } } } }, responses: { 200: { description: "Test connection result", content: { "application/json": { schema: llmTestConnectionResponseSchema } } }, 400: { description: "INVALID_REQUEST" } } });

const pluginIdParam = z.object({ pluginId: z.string().min(1) });
const pluginPageParam = pluginIdParam.extend({ pageId: z.string().min(1) });

registry.registerPath({
  method: "get", path: "/v1/plugins/{pluginId}/config/schema", summary: "读取插件配置 Schema", tags: ["Plugins"],
  request: { params: pluginIdParam, headers: scopeHeaders },
  responses: { 200: { description: "Schema", content: { "application/json": { schema: pluginConfigSchemaOpenApi } } }, 404: { description: "Plugin or schema not found" } },
});
registry.registerPath({
  method: "put", path: "/v1/plugins/{pluginId}/config/schema", summary: "注册/更新插件配置 Schema", tags: ["Plugins"],
  request: { params: pluginIdParam, headers: scopeHeaders, body: { content: { "application/json": { schema: pluginConfigSchemaOpenApi } } } },
  responses: { 200: { description: "Schema", content: { "application/json": { schema: pluginConfigSchemaOpenApi } } }, 400: { description: "INVALID_CONFIG_SCHEMA" } },
});
registry.registerPath({
  method: "get", path: "/v1/plugins/{pluginId}/config", summary: "读取插件配置（secret 仅返回状态）", tags: ["Plugins"],
  request: { params: pluginIdParam, headers: scopeHeaders },
  responses: { 200: { description: "Snapshot", content: { "application/json": { schema: pluginConfigSnapshotSchema } } }, 404: { description: "Plugin not found" } },
});
registry.registerPath({
  method: "put", path: "/v1/plugins/{pluginId}/config", summary: "保存插件配置（revision CAS）", tags: ["Plugins"],
  request: { params: pluginIdParam, headers: scopeHeaders, body: { content: { "application/json": { schema: pluginConfigUpdateRequestSchema } } } },
  responses: { 200: { description: "Snapshot", content: { "application/json": { schema: pluginConfigSnapshotSchema } } }, 400: { description: "INVALID_CONFIG" }, 404: { description: "Plugin not found" }, 409: { description: "PLUGIN_CONFIG_REVISION_CONFLICT" } },
});
registry.registerPath({
  method: "post", path: "/v1/plugins/{pluginId}/config/reset", summary: "重置插件配置", tags: ["Plugins"],
  request: { params: pluginIdParam, headers: scopeHeaders },
  responses: { 200: { description: "Snapshot", content: { "application/json": { schema: pluginConfigSnapshotSchema } } }, 404: { description: "Plugin not found" } },
});
registry.registerPath({
  method: "get", path: "/v1/plugins/{pluginId}/pages", summary: "列出插件 Page", tags: ["Plugins"],
  request: { params: pluginIdParam, headers: scopeHeaders },
  responses: { 200: { description: "Pages", content: { "application/json": { schema: z.object({ pages: z.array(pluginPageSchema) }) } } }, 404: { description: "Plugin not found" } },
});
registry.registerPath({
  method: "post", path: "/v1/plugins/{pluginId}/pages", summary: "注册插件 Page 元数据", tags: ["Plugins"],
  request: { params: pluginIdParam, headers: scopeHeaders, body: { content: { "application/json": { schema: pluginPageSchema } } } },
  responses: { 201: { description: "Created", content: { "application/json": { schema: pluginPageSchema } } }, 400: { description: "INVALID_PAGE" } },
});
registry.registerPath({
  method: "post", path: "/v1/plugins/{pluginId}/pages/{pageId}/assets", summary: "写入插件 Page 静态资源（base64）", tags: ["Plugins"],
  request: { params: pluginPageParam, headers: scopeHeaders, body: { content: { "application/json": { schema: pluginPageAssetsRequestSchema } } } },
  responses: { 201: { description: "Written" }, 400: { description: "INVALID_ASSET_PATH" } },
});
registry.registerPath({
  method: "get",
  path: "/v1/plugin-pages/bridge.js",
  summary: "Page Bridge SDK",
  tags: ["Plugins"],
  responses: { 200: { description: "JavaScript" } },
});

const practiceSessionIdParam = z.object({ sessionId: z.string().min(1) });
const learningQuestionIdParam = z.object({ questionId: z.string().min(1) });
const reviewItemIdParam = z.object({ reviewId: z.string().min(1) });
const reportIdParam = z.object({ reportId: z.string().min(1) });
const learningPlanIdParam = z.object({ planId: z.string().min(1) });
const planTaskIdParam = z.object({ taskId: z.string().min(1) });
const mistakeListQuery = z.object({ status: mistakeStatusEnumSchema.optional() });

registry.registerPath({
  method: "post", path: "/v1/practice/sessions", summary: "创建短时练习会话（3~5 题）", tags: ["Learning"],
  request: { headers: scopeHeaders, body: { content: { "application/json": { schema: createPracticeSessionRequestSchema } } } },
  responses: { 200: { description: "Resumed active session", content: { "application/json": { schema: practiceSessionResumeResponseSchema } } }, 201: { description: "Created", content: { "application/json": { schema: practiceSessionResumeResponseSchema } } }, 400: { description: "count 必须为 3~5 的整数" }, 409: { description: "活跃题目数量不足" } },
});

registry.registerPath({ method: "post", path: "/v1/practice-reports", summary: "创建自适应练习报告", tags: ["Learning"], request: { headers: scopeHeaders, body: { content: { "application/json": { schema: createPracticeReportSchema } } } }, responses: { 201: { description: "Created", content: { "application/json": { schema: practiceReportResponseSchema } } }, 400: { description: "Validation failed" } } });
registry.registerPath({ method: "get", path: "/v1/practice-reports/{reportId}", summary: "读取自适应练习报告", tags: ["Learning"], request: { params: reportIdParam, headers: scopeHeaders }, responses: { 200: { description: "Report", content: { "application/json": { schema: practiceReportResponseSchema } } }, 404: { description: "Report not found" } } });
registry.registerPath({ method: "get", path: "/v1/practice-sessions/{sessionId}/reports", summary: "列出会话练习报告", tags: ["Learning"], request: { params: practiceSessionIdParam, headers: scopeHeaders }, responses: { 200: { description: "Reports", content: { "application/json": { schema: practiceReportListResponseSchema } } } } });
registry.registerPath({ method: "post", path: "/v1/practice-sessions/{sessionId}/reset-inference", summary: "重置会话报告推断", tags: ["Learning"], request: { params: practiceSessionIdParam, headers: scopeHeaders }, responses: { 201: { description: "Reset report", content: { "application/json": { schema: practiceReportResponseSchema } } } } });
registry.registerPath({ method: "post", path: "/v1/learning-plans/generate", summary: "AI 生成学习规划（里程碑+任务路线图）", tags: ["Learning"], request: { headers: scopeHeaders, body: { content: { "application/json": { schema: generateLearningPlanSchema } } } }, responses: { 201: { description: "Created", content: { "application/json": { schema: learningPlanResponseSchema } } }, 400: { description: "Validation failed / LLM 未配置" } } });
registry.registerPath({ method: "get", path: "/v1/learning-plans", summary: "列出学习规划", tags: ["Learning"], request: { headers: scopeHeaders }, responses: { 200: { description: "Plans", content: { "application/json": { schema: learningPlanListResponseSchema } } } } });
registry.registerPath({ method: "get", path: "/v1/learning-plans/{planId}", summary: "获取学习规划详情", tags: ["Learning"], request: { params: learningPlanIdParam, headers: scopeHeaders }, responses: { 200: { description: "Plan", content: { "application/json": { schema: learningPlanResponseSchema } } }, 404: { description: "Plan not found" } } });
registry.registerPath({ method: "patch", path: "/v1/plan-tasks/{taskId}", summary: "更新规划任务状态（勾选/取消完成）", tags: ["Learning"], request: { params: planTaskIdParam, headers: scopeHeaders, body: { content: { "application/json": { schema: updatePlanTaskStatusSchema } } } }, responses: { 200: { description: "Updated plan", content: { "application/json": { schema: learningPlanResponseSchema } } }, 400: { description: "Validation failed" }, 404: { description: "Task not found" } } });
registry.registerPath({ method: "post", path: "/v1/learning-plans/{planId}/archive", summary: "归档学习规划", tags: ["Learning"], request: { params: learningPlanIdParam, headers: scopeHeaders }, responses: { 200: { description: "Archived", content: { "application/json": { schema: learningPlanResponseSchema } } }, 404: { description: "Plan not found" } } });
registry.registerPath({
  method: "get", path: "/v1/practice/sessions/active", summary: "恢复当前活跃练习会话", tags: ["Learning"],
  request: { headers: scopeHeaders },
  responses: { 200: { description: "Active practice session", content: { "application/json": { schema: practiceSessionResumeResponseSchema } } }, 404: { description: "PRACTICE_SESSION_NOT_FOUND" } },
});
registry.registerPath({
  method: "get", path: "/v1/practice/sessions/{sessionId}/report", summary: "读取练习会话报告", tags: ["Learning"],
  request: { params: practiceSessionIdParam, headers: scopeHeaders },
  responses: { 200: { description: "Report", content: { "application/json": { schema: practiceReportSchema } } }, 404: { description: "PRACTICE_SESSION_NOT_FOUND" } },
});
registry.registerPath({
  method: "post", path: "/v1/practice/sessions/{sessionId}/complete", summary: "结束练习会话并返回报告", tags: ["Learning"],
  request: { params: practiceSessionIdParam, headers: scopeHeaders },
  responses: { 200: { description: "Report", content: { "application/json": { schema: practiceReportSchema } } }, 404: { description: "PRACTICE_SESSION_NOT_FOUND" } },
});
registry.registerPath({
  method: "get", path: "/v1/mistakes", summary: "列出错题本", tags: ["Learning"],
  request: { query: mistakeListQuery.extend({ reasonCode: mistakeReasonCodeSchema.optional() }), headers: scopeHeaders },
  responses: { 200: { description: "Mistakes", content: { "application/json": { schema: mistakeListResponseSchema } } }, 400: { description: "status 非法" } },
});
registry.registerPath({
  method: "patch", path: "/v1/mistakes/{questionId}", summary: "更新错题处置或错因", tags: ["Learning"],
  request: { params: learningQuestionIdParam, headers: scopeHeaders, body: { content: { "application/json": { schema: updateMistakeRequestSchema } } } },
  responses: { 200: { description: "Updated", content: { "application/json": { schema: mistakeItemSchema } } }, 400: { description: "status 非法" }, 404: { description: "MISTAKE_NOT_FOUND" }, 409: { description: "错题无关联知识点" } },
});
registry.registerPath({
  method: "post", path: "/v1/mistakes/repractice", summary: "从错题本创建重练会话", tags: ["Learning"],
  request: { headers: scopeHeaders, body: { content: { "application/json": { schema: repracticeRequestSchema } } } },
  responses: { 200: { description: "Resumed active session", content: { "application/json": { schema: practiceSessionResumeResponseSchema } } }, 201: { description: "Created", content: { "application/json": { schema: createPracticeSessionResponseSchema } } }, 400: { description: "questionIds 非法或含非活跃错题" }, 409: { description: "错题题目不可用" } },
});
registry.registerPath({
  method: "post", path: "/v1/questions/{questionId}/attempts", summary: "作答题目（不可变学习事实，可关联练习会话）", tags: ["Learning"],
  request: { params: learningQuestionIdParam, headers: scopeHeaders.extend({ "Idempotency-Key": z.string().min(1).optional() }), body: { content: { "application/json": { schema: createAttemptRequestSchema } } } },
  responses: { 201: { description: "Attempt created" }, 200: { description: "Existing idempotent attempt" }, 400: { description: "请求或会话信息非法" }, 404: { description: "QUESTION_NOT_FOUND" }, 409: { description: "练习会话未激活或题目不属于该会话" } },
});

registry.registerPath({
  method: "get", path: "/v1/review-items", summary: "列出到期复习项", tags: ["Learning"],
  request: { headers: scopeHeaders, query: z.object({ dueBefore: z.string().optional() }) },
  responses: { 200: { description: "Due review items", content: { "application/json": { schema: reviewListResponseSchema } } } },
});
registry.registerPath({
  method: "get", path: "/v1/review-items/summary", summary: "读取到期复习汇总", tags: ["Learning"],
  request: { headers: scopeHeaders, query: z.object({ dueBefore: z.string().optional(), timeZone: z.string().optional() }) },
  responses: { 200: { description: "Due review summary", content: { "application/json": { schema: reviewSummaryResponseSchema } } } },
});
registry.registerPath({
  method: "get", path: "/v1/review-items/history", summary: "读取最近复习历史", tags: ["Learning"],
  request: { headers: scopeHeaders, query: z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }) },
  responses: { 200: { description: "Recent completed reviews", content: { "application/json": { schema: reviewHistoryResponseSchema } } }, 400: { description: "limit 非法" } },
});
registry.registerPath({
  method: "post", path: "/v1/review-items/{reviewId}/complete", summary: "完成复习并调度下一项（幂等重放）", tags: ["Learning"],
  request: { params: reviewItemIdParam, headers: scopeHeaders, body: { content: { "application/json": { schema: completeReviewRequestSchema } } } },
  responses: { 200: { description: "Completion result or matching replay", content: { "application/json": { schema: completeReviewResponseSchema } } }, 400: { description: "isCorrect 缺失或非法" }, 404: { description: "REVIEW_ITEM_NOT_FOUND" }, 409: { description: "完成结果与首次请求不一致" } },
});

/** 受控收件箱提交端点（阶段 5a-2：followup / steer / inject 三 command 统一入口） */
registry.registerPath({
  method: "post",
  path: "/v1/sessions/{sessionId}/inbox",
  summary: "提交受控 inbox command（followup/steer/inject；幂等）",
  tags: ["Inbox"],
  request: {
    params: sessionIdParam,
    headers: scopeHeaders.extend({
      "X-Plugin-Id": z.string().min(1).optional(),
      "Idempotency-Key": z.string().min(1).optional(),
    }),
    body: {
      content: {
        "application/json": { schema: createInboxItemRequestSchema },
      },
    },
  },
  responses: {
    201: {
      description: "Created",
      content: { "application/json": { schema: inboxItemResponseSchema } },
    },
    200: {
      description: "Existing idempotent item",
      content: { "application/json": { schema: inboxItemResponseSchema } },
    },
    400: { description: "type/payload/consumeBoundary 非法" },
    403: { description: "插件未安装/未启用/无 inbox 权限" },
  },
});

registry.registerPath({
  method: "post",
  path: "/v1/terms/explore",
  summary: "追问探索概念/术语（CAP-007 / CAP-002）",
  description: "支持深挖（child）、对比发散（related）与分支对话（branch）三种追问探索模式",
  request: {
    body: {
      content: { "application/json": { schema: termExploreRequestSchema } },
    },
  },
  responses: {
    200: {
      description: "探索结果与关联思考问题",
      content: { "application/json": { schema: termExploreResponseSchema } },
    },
  },
});

const generator = new OpenApiGeneratorV31(registry.definitions);


export const openApiDocument: OpenAPIObject = generator.generateDocument({
  openapi: "3.1.0",
  info: {
    title: "Aervox｜思隅 API",
    version: "0.2.0",
    description:
      "Turn streaming plus Persona, Anthropic Skills, MCP policy, and GPT-SoVITS contracts.",
  },
  servers: [{ url: "http://localhost:3000" }],
});
