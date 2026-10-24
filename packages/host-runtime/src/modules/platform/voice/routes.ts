/**
 * Aervox｜思隅 @aervox/api — 语音服务 HTTP 路由
 */
import type { FastifyInstance } from "fastify";
import {
  voiceApi,
  localVoiceConfigSchema,
  voiceSynthesisRequestSchema,
  voiceInputConfigSchema,
  voiceTranscribeRequestSchema,
  remoteVoiceConfigSchema,
  voiceRemoteTestConnectionRequestSchema,
  voiceCreatePresetRequestSchema,
} from "@aervox/contracts";
import { registerContractRoute } from "../../../shared/contract-route.js";
import { resolveLocalContext } from "../../../shared/local-context.js";
import { GptSovitsRemoteProvider } from "./gpt-sovits.js";
import type { VoiceService } from "./service.js";

function asBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Buffer {
  return Buffer.from(value, "base64");
}

export function registerVoiceRoutes(app: FastifyInstance, service: VoiceService): void {
  registerContractRoute(app, voiceApi.models, async () => {
    const models = await service.listModels();
    return { models };
  });

  registerContractRoute(app, voiceApi.synthesize, async (request, reply) => {
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
  registerContractRoute(app, voiceApi.local, async (request) => {
    const tenant = resolveLocalContext(request);
    return service.getLocalConfig(tenant);
  });

  // PUT /v1/voice/config — 保存本地语音模型配置（modelPath 受 allowedRoots 白名单约束）
  registerContractRoute(app, voiceApi.saveLocal, async (request, reply) => {
    const parsed = localVoiceConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_VOICE_CONFIG",
        message: "Invalid local voice config",
        details: parsed.error.issues,
      });
    }
    const tenant = resolveLocalContext(request);
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

  // GET /v1/voice/remote/config — 读取当前租户在线语音模型配置（CR-028）
  registerContractRoute(app, voiceApi.remote, async (request) => {
    const tenant = resolveLocalContext(request);
    return service.getRemoteConfig(tenant);
  });

  // PUT /v1/voice/remote/config — 保存在线语音模型配置（endpoint 必须为合法 http(s) URL）
  registerContractRoute(app, voiceApi.saveRemote, async (request, reply) => {
    const parsed = remoteVoiceConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_VOICE_REMOTE_CONFIG",
        message: "Invalid remote voice config",
        details: parsed.error.issues,
      });
    }
    const tenant = resolveLocalContext(request);
    try {
      const cfg = await service.setRemoteConfig(tenant, { ...parsed.data, settings: parsed.data.settings ?? {} });
      return cfg;
    } catch (error) {
      return reply.code(400).send({
        code: "INVALID_VOICE_REMOTE_CONFIG",
        message: error instanceof Error ? error.message : "Invalid remote voice config",
      });
    }
  });

  // POST /v1/voice/remote/test-connection — 在线语音服务连通性测试（CR-028，对齐 /v1/llm/test-connection 先例）
  registerContractRoute(app, voiceApi.testRemote, async (request, reply) => {
    const parsed = voiceRemoteTestConnectionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_REQUEST",
        message: "Invalid test connection request",
        details: parsed.error.issues,
      });
    }
    const probe = new GptSovitsRemoteProvider("voice-remote-test-probe", {
      endpoint: parsed.data.endpoint,
      protocol: "http",
      modelId: parsed.data.modelId,
      ...(parsed.data.apiKey ? { secretRef: parsed.data.apiKey } : {}),
    });
    const startedAt = Date.now();
    const health = await probe.healthCheck();
    return {
      ok: health.status === "healthy",
      latencyMs: Date.now() - startedAt,
      message: health.message ?? (health.status === "healthy" ? "服务可达" : "服务不可用"),
    };
  });

  // GET /v1/voice/input/config — 读取离线语音输入配置（CR-016）
  registerContractRoute(app, voiceApi.input, async (request) => {
    const tenant = resolveLocalContext(request);
    return service.getVoiceInputConfig(tenant);
  });

  // PUT /v1/voice/input/config — 保存离线语音输入配置
  registerContractRoute(app, voiceApi.saveInput, async (request, reply) => {
    const parsed = voiceInputConfigSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_VOICE_INPUT_CONFIG",
        message: "Invalid voice input config",
        details: parsed.error.issues,
      });
    }
    const tenant = resolveLocalContext(request);
    try {
      const cfg = await service.setVoiceInputConfig(tenant, { ...parsed.data, settings: parsed.data.settings ?? {} });
      return cfg;
    } catch (error) {
      return reply.code(400).send({
        code: "INVALID_VOICE_INPUT_CONFIG",
        message: error instanceof Error ? error.message : "Invalid voice input config",
      });
    }
  });

  // GET /v1/voice/input/model/status — 读取模型状态
  registerContractRoute(app, voiceApi.modelStatus, async (request) => {
    const tenant = resolveLocalContext(request);
    return service.getVoiceInputModelStatus(tenant);
  });

  // POST /v1/voice/input/model/download — 触发模型下载
  registerContractRoute(app, voiceApi.downloadModel, async (request, reply) => {
    const tenant = resolveLocalContext(request);
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
  registerContractRoute(app, voiceApi.transcribe, async (request, reply) => {
    const parsed = voiceTranscribeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_AUDIO",
        message: "Invalid audio transcribe payload",
        details: parsed.error.issues,
      });
    }
    const tenant = resolveLocalContext(request);
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => { if (!reply.raw.writableEnded) abort(); };
    request.raw.once("aborted", abort);
    reply.raw.once("close", close);
    try {
      const audioBuffer = fromBase64(parsed.data.audioBase64);
      const result = await service.transcribe(tenant, {
        signal: controller.signal,
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
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", close);
    }
  });

  // ---- 多预设管理（与人格设定同款：列表/新建/激活/删除） ----

  // GET /v1/voice/presets — 列出全部语音配置预设（含激活标记与三块配置）
  registerContractRoute(app, voiceApi.presets, async (request) => {
    const tenant = resolveLocalContext(request);
    return service.listVoicePresets(tenant);
  });

  // POST /v1/voice/presets — 新建语音配置预设
  registerContractRoute(app, voiceApi.createPreset, async (request, reply) => {
    const parsed = voiceCreatePresetRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_VOICE_PRESET",
        message: "Invalid voice preset payload",
        details: parsed.error.issues,
      });
    }
    const tenant = resolveLocalContext(request);
    try {
      const created = await service.createVoicePreset(tenant, parsed.data.name);
      return created;
    } catch (error) {
      return reply.code(400).send({
        code: "INVALID_VOICE_PRESET",
        message: error instanceof Error ? error.message : "Invalid voice preset",
      });
    }
  });

  // POST /v1/voice/presets/:presetId/activate — 激活指定语音配置预设
  registerContractRoute(app, voiceApi.activatePreset, async (request, reply) => {
    const { presetId } = request.params as { presetId: string };
    const tenant = resolveLocalContext(request);
    const activated = await service.activateVoicePreset(tenant, presetId);
    if (!activated) {
      return reply.code(404).send({ code: "PRESET_NOT_FOUND", message: "Voice preset not found" });
    }
    return activated;
  });

  // DELETE /v1/voice/presets/:presetId — 删除指定语音配置预设
  registerContractRoute(app, voiceApi.deletePreset, async (request, reply) => {
    const { presetId } = request.params as { presetId: string };
    const tenant = resolveLocalContext(request);
    const deleted = await service.deleteVoicePreset(tenant, presetId);
    if (!deleted) {
      return reply.code(404).send({ code: "PRESET_NOT_FOUND", message: "Voice preset not found" });
    }
    return { deleted: true, presetId };
  });
}
