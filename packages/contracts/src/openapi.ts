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
  messageEventDataSchema,
  petCommandSchema,
  petManifestSchema,
  petSheetLayoutSchema,
  petSheetStateSchema,
  redactedEventDataSchema,
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

const registry = new OpenAPIRegistry();

registry.register("CreateLearningGoal", createLearningGoalSchema);
registry.register("UpdateLearningGoal", updateLearningGoalSchema);
registry.register("CreateTurnRequest", createTurnRequestSchema);
registry.register("CreateTurnResponse", createTurnResponseSchema);
registry.register("CancelTurnResponse", cancelTurnResponseSchema);
registry.register("TurnStreamEvent", turnStreamEventSchema);
registry.register("MessageEventData", messageEventDataSchema);
registry.register("DeltaEventData", deltaEventDataSchema);
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

const sessionIdParam = z.object({ sessionId: z.string().min(1) });
const turnIdParam = z.object({ turnId: z.string().min(1) });

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
const scopeHeaders = z.object({
  "X-Workspace-Id": z.string().min(1).optional(),
  "X-User-Id": z.string().min(1).optional(),
  "X-Actor-Id": z.string().min(1).optional(),
});

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
const mistakeListQuery = z.object({ status: mistakeStatusEnumSchema.optional() });

registry.registerPath({
  method: "post", path: "/v1/practice/sessions", summary: "创建短时练习会话（3~5 题）", tags: ["Learning"],
  request: { headers: scopeHeaders, body: { content: { "application/json": { schema: createPracticeSessionRequestSchema } } } },
  responses: { 200: { description: "Resumed active session", content: { "application/json": { schema: practiceSessionResumeResponseSchema } } }, 201: { description: "Created", content: { "application/json": { schema: practiceSessionResumeResponseSchema } } }, 400: { description: "count 必须为 3~5 的整数" }, 409: { description: "活跃题目数量不足" } },
});
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
  request: { query: mistakeListQuery, headers: scopeHeaders },
  responses: { 200: { description: "Mistakes", content: { "application/json": { schema: mistakeListResponseSchema } } }, 400: { description: "status 非法" } },
});
registry.registerPath({
  method: "patch", path: "/v1/mistakes/{questionId}", summary: "标记错题掌握状态", tags: ["Learning"],
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
