/**
 * Aervox｜思隅 @aervox/api — 语音服务 HTTP 路由
 */
import type { FastifyInstance } from "fastify";
import {
  localVoiceConfigSchema,
  voiceSynthesisRequestSchema,
  voiceInputConfigSchema,
  voiceTranscribeRequestSchema,
} from "@aervox/contracts";
import { resolveTenant } from "../../shared/tenant.js";
import type { VoiceService } from "./service.js";

function asBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

export function registerVoiceRoutes(app: FastifyInstance, service: VoiceService): void {
  app.get("/v1/voice/models", async () => {
    const models = await service.listModels();
    return { models };
  });

  app.post("/v1/voice/synthesize", async (request, reply) => {
    const parsed = voiceSynthesisRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_VOICE_REQUEST",
        message: "Invalid voice synthesis request",
        details: parsed.error.issues,
      });
    }
    if (!service.hasProvider(parsed.data.providerId)) {
      return reply.code(503).send({
        code: "VOICE_PROVIDER_UNAVAILABLE",
        message: `Voice provider ${parsed.data.providerId} is unavailable`,
      });
    }
    try {
      const artifact = await service.synthesize(parsed.data.providerId, parsed.data);
      return {
        providerId: artifact.providerId,
        modelId: artifact.modelId,
        contentType: artifact.contentType,
        audioBase64: asBase64(artifact.bytes),
      };
    } catch (error) {
      return reply.code(503).send({
        code: "VOICE_PROVIDER_UNAVAILABLE",
        message: error instanceof Error ? error.message : "Voice synthesis failed",
      });
    }
  });

  // GET /v1/voice/config — 读取当前租户本地语音模型配置（CR-011 阶段 1）
  app.get("/v1/voice/config", async (request) => {
    const tenant = resolveTenant(request);
    return service.getLocalConfig(tenant);
  });

  // PUT /v1/voice/config — 保存本地语音模型配置（modelPath 受 allowedRoots 白名单约束）
  app.put("/v1/voice/config", async (request, reply) => {
    const parsed = localVoiceConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_VOICE_CONFIG",
        message: "Invalid local voice config",
        details: parsed.error.issues,
      });
    }
    const tenant = resolveTenant(request);
    try {
      const cfg = await service.setLocalConfig(tenant, parsed.data);
      return cfg;
    } catch (error) {
      return reply.code(400).send({
        code: "INVALID_VOICE_CONFIG",
        message: error instanceof Error ? error.message : "Invalid local voice config",
      });
    }
  });

  // GET /v1/voice/input/config — 读取离线语音输入配置（CR-016）
  app.get("/v1/voice/input/config", async (request) => {
    const tenant = resolveTenant(request);
    return service.getVoiceInputConfig(tenant);
  });

  // PUT /v1/voice/input/config — 保存离线语音输入配置
  app.put("/v1/voice/input/config", async (request, reply) => {
    const parsed = voiceInputConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_VOICE_INPUT_CONFIG",
        message: "Invalid voice input config",
        details: parsed.error.issues,
      });
    }
    const tenant = resolveTenant(request);
    try {
      const cfg = await service.setVoiceInputConfig(tenant, parsed.data as any);
      return cfg;
    } catch (error) {
      return reply.code(400).send({
        code: "INVALID_VOICE_INPUT_CONFIG",
        message: error instanceof Error ? error.message : "Invalid voice input config",
      });
    }
  });

  // GET /v1/voice/input/model/status — 读取模型状态
  app.get("/v1/voice/input/model/status", async (request) => {
    const tenant = resolveTenant(request);
    return service.getVoiceInputModelStatus(tenant);
  });

  // POST /v1/voice/input/model/download — 触发模型下载
  app.post("/v1/voice/input/model/download", async (request, reply) => {
    const tenant = resolveTenant(request);
    const body = (request.body as { targetDir?: string; mirrorUrl?: string } | undefined) ?? {};
    try {
      const result = await service.downloadVoiceInputModel(tenant, body);
      return result;
    } catch (error) {
      return reply.code(400).send({
        code: "INVALID_DOWNLOAD_REQUEST",
        message: error instanceof Error ? error.message : "Failed to download model",
      });
    }
  });

  // POST /v1/voice/transcribe — 离线语音识别转写
  app.post("/v1/voice/transcribe", async (request, reply) => {
    const parsed = voiceTranscribeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_AUDIO",
        message: "Invalid audio transcribe payload",
        details: parsed.error.issues,
      });
    }
    const tenant = resolveTenant(request);
    try {
      const audioBuffer = fromBase64(parsed.data.audioBase64);
      const result = await service.transcribe(tenant, {
        audioBuffer,
        mimeType: parsed.data.mimeType,
        language: parsed.data.language,
      });
      return result;
    } catch (error) {
      // CR-016 安全/契约整改：真实错误返回 503，不再吞成 200 文案（避免错误被当作转写文本插入输入框）
      return reply.code(503).send({
        code: "VOICE_INPUT_PROVIDER_UNAVAILABLE",
        message: error instanceof Error ? error.message : "转写异常",
      });
    }
  });
}
