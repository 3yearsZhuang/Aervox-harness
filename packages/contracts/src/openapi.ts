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
  errorEventDataSchema,
  messageEventDataSchema,
  redactedEventDataSchema,
  streamErrorCodeSchema,
  turnStreamEventSchema,
} from "./schemas.js";
import {
  activatePersonaRequestSchema,
  activePersonaSelectionSchema,
  createPersonaRequestSchema,
  exportSkillsRequestSchema,
  importPersonaRequestSchema,
  importSkillsRequestSchema,
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
} from "./persona-schemas.js";

const registry = new OpenAPIRegistry();

registry.register("CreateLearningGoal", createLearningGoalSchema);
registry.register("CreateTurnRequest", createTurnRequestSchema);
registry.register("CreateTurnResponse", createTurnResponseSchema);
registry.register("CancelTurnResponse", cancelTurnResponseSchema);
registry.register("TurnStreamEvent", turnStreamEventSchema);
registry.register("MessageEventData", messageEventDataSchema);
registry.register("DeltaEventData", deltaEventDataSchema);
registry.register("DoneEventData", doneEventDataSchema);
registry.register("ErrorEventData", errorEventDataSchema);
registry.register("RedactedEventData", redactedEventDataSchema);
registry.register("StreamErrorCode", streamErrorCodeSchema);
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
registry.register("PersonaBundleResponse", personaBundleResponseSchema);
registry.register("SkillZipResponse", skillZipResponseSchema);

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
    body: { content: { "application/json": { schema: createLearningGoalSchema } } },
  },
  responses: {
    201: { description: "Created" },
    400: { description: "Invalid request（topic/availableMinutes 非法）" },
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
