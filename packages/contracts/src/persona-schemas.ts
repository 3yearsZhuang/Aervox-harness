import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const personaSourceSchema = z.enum(["builtin", "user_created", "imported"]);
export const personaStatusSchema = z.enum(["active", "archived"]);
export const personaReviewStatusSchema = z.enum(["draft", "pending_review", "approved", "rejected"]);
export const memoryPolicySchema = z.enum(["isolated", "shared"]);
export const memoryCategorySchema = z.enum(["learning", "preference", "diary", "fact"]);
export const switchReasonSchema = z.enum(["user_initiated", "rollback", "system_default"]);
export const voiceSelectionSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  speakerId: z.string().min(1).optional(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export const personaRevisionConfigSchema = z.object({
  systemPromptAppend: z.string().min(1).max(32_000),
  allowedSkillNames: z.array(z.string().min(1)).optional(),
  allowedMcpToolIds: z.array(z.string().min(1)).optional(),
  voice: voiceSelectionSchema.optional(),
});
export const personaSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  subjectUserId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  source: personaSourceSchema,
  status: personaStatusSchema,
  reviewStatus: personaReviewStatusSchema,
  reviewNotes: z.string(),
  reviewedAt: z.iso.datetime().nullable(),
  currentRevisionId: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const personaRevisionSchema = z.object({
  id: z.string().min(1),
  personaId: z.string().min(1),
  revision: z.number().int().positive(),
  config: personaRevisionConfigSchema,
  checksum: z.string().length(64),
  createdAt: z.iso.datetime(),
});
export const activePersonaSelectionSchema = z.object({
  workspaceId: z.string().min(1),
  subjectUserId: z.string().min(1),
  personaId: z.string().min(1),
  revisionId: z.string().min(1),
  selectedAt: z.iso.datetime(),
});
export const skillSummarySchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  license: z.string().optional(),
  compatibility: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  allowedTools: z.array(z.string()).optional(),
  source: z.enum(["active", "workspace", "imported"]),
  version: z.number().int().positive(),
  checksum: z.string().length(64),
  enabled: z.boolean(),
  valid: z.boolean(),
  validationErrors: z.array(z.string()),
  importedAt: z.iso.datetime(),
});
export const mcpToolSchema = z.object({
  id: z.string().min(1),
  serverId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  inputSchema: z.unknown(),
  scopes: z.array(z.string()),
  healthy: z.boolean(),
  authorized: z.boolean(),
  revoked: z.boolean(),
  killSwitch: z.boolean(),
});
export const voiceSynthesisRequestSchema = z.object({
  providerId: z.string().min(1),
  text: z.string().min(1).max(20_000),
  modelId: z.string().min(1),
  speakerId: z.string().min(1).optional(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
export const voiceSynthesisResponseSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  contentType: z.string().min(1),
  audioBase64: z.string().min(1),
});

export const voiceModelSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  speakerIds: z.array(z.string()),
  available: z.boolean(),
  source: z.enum(["local", "remote"]),
});

/** 本地语音模型配置（WebUI 设置「语音」读写；CR-011 阶段 1） */
export const localVoiceConfigSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().min(1),
  modelPath: z.string().min(1).optional(),
  modelId: z.string().min(1),
  speakerId: z.string().min(1).optional(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});
/** 本地语音模型配置读取响应（缺省时按 env 给出默认值） */
export const localVoiceConfigResponseSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().min(1),
  modelPath: z.string().optional(),
  modelId: z.string().min(1),
  speakerId: z.string().optional(),
  settings: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({}),
});

/** GPT-SoVITS api_v2 支持的文本语言（/tts 的 text_lang 参数） */
export const voiceTextLangSchema = z.enum(["auto", "zh", "en", "ja", "ko", "yue"]);

/**
 * 在线语音模型（GPT-SoVITS 远程 API）配置（CR-028）。
 * endpoint 为 api_v2 服务 base URL（如 http://127.0.0.1:9880）；
 * refAudioPath 是 GPT-SoVITS 机器上的参考音频路径，不是本机路径。
 */
export const remoteVoiceConfigSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().min(1).default("gpt-sovits-remote"),
  endpoint: z.string().min(1),
  apiKey: z.string().optional(),
  modelId: z.string().min(1),
  speakerId: z.string().min(1).optional(),
  textLang: voiceTextLangSchema.optional(),
  refAudioPath: z.string().min(1).optional(),
  promptText: z.string().min(1).optional(),
  promptLang: voiceTextLangSchema.optional(),
  auxRefAudioPaths: z.array(z.string().min(1)).optional(),
  speedFactor: z.number().min(0.6).max(1.65).optional(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/** 在线语音模型配置读取响应（缺省时按 env 给出默认值） */
export const remoteVoiceConfigResponseSchema = z.object({
  enabled: z.boolean(),
  providerId: z.string().min(1),
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  modelId: z.string().min(1),
  speakerId: z.string().optional(),
  textLang: voiceTextLangSchema.optional(),
  refAudioPath: z.string().optional(),
  promptText: z.string().optional(),
  promptLang: voiceTextLangSchema.optional(),
  auxRefAudioPaths: z.array(z.string()).optional(),
  speedFactor: z.number().optional(),
  settings: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({}),
});

/** 在线语音服务连通性测试请求（对齐 llmTestConnectionRequestSchema 先例） */
export const voiceRemoteTestConnectionRequestSchema = z.object({
  endpoint: z.string().min(1),
  apiKey: z.string().optional(),
  modelId: z.string().min(1).default("default-remote"),
});

/** 在线语音服务连通性测试响应 */
export const voiceRemoteTestConnectionResponseSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  message: z.string(),
});

/** 离线语音输入引擎类型（CR-016） */
export const voiceInputEngineTypeSchema = z.enum(["sensevoice-local", "whisper-compatible"]);

/** 离线语音输入 (ASR) 配置 */
export const voiceInputConfigSchema = z.object({
  enabled: z.boolean(),
  engineType: voiceInputEngineTypeSchema,
  modelPath: z.string().optional(),
  modelId: z.string().min(1).default("sensevoice-small"),
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  autoStopOnKeyboard: z.boolean().default(true),
  vadSilenceThresholdMs: z.number().int().min(200).max(3000).default(700),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/** 离线语音输入 (ASR) 配置响应 */
export const voiceInputConfigResponseSchema = z.object({
  enabled: z.boolean(),
  engineType: voiceInputEngineTypeSchema,
  modelPath: z.string().optional(),
  modelId: z.string().min(1),
  endpoint: z.string().optional(),
  apiKey: z.string().optional(),
  autoStopOnKeyboard: z.boolean().default(true),
  vadSilenceThresholdMs: z.number().int().default(700),
  settings: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .default({}),
});

/** 语音转写请求 */
export const voiceTranscribeRequestSchema = z.object({
  audioBase64: z.string().min(1),
  mimeType: z.string().default("audio/wav"),
  language: z.string().optional(),
});

/** 语音转写响应 */
export const voiceTranscribeResponseSchema = z.object({
  text: z.string(),
  durationMs: z.number().optional(),
  isFinal: z.boolean().default(true),
});

/** 语音输入离线模型状态 */
export const voiceInputModelStatusSchema = z.object({
  downloaded: z.boolean(),
  downloading: z.boolean(),
  progressPercent: z.number().min(0).max(100).default(0),
  downloadedBytes: z.number().int().nonnegative().optional(),
  totalBytes: z.number().int().positive().optional(),
  verified: z.boolean().default(false),
  checksum: z.string().optional(),
  modelPath: z.string().optional(),
  message: z.string().optional(),
});

/** 触发下载离线语音输入模型请求 */
export const voiceInputModelDownloadRequestSchema = z.object({
  targetDir: z.string().optional(),
  mirrorUrl: z.string().optional(),
});

/** 触发下载离线语音输入模型响应 */
export const voiceInputModelDownloadResponseSchema = z.object({
  accepted: z.boolean(),
  message: z.string(),
  status: voiceInputModelStatusSchema,
});

/** 语音配置预设条目（多预设：本地输出/在线输出/输入共享 id+name+isActive） */
export const voicePresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  isActive: z.boolean(),
  /** 本地语音输出配置（可空表示该预设未配置本地模式） */
  local: localVoiceConfigResponseSchema.nullable(),
  /** 在线语音输出配置（可空表示该预设未配置在线模式） */
  remote: remoteVoiceConfigResponseSchema.nullable(),
  /** 语音输入 (ASR) 配置（可空表示该预设未配置输入） */
  input: voiceInputConfigResponseSchema.nullable(),
});

/** 语音配置预设列表响应 */
export const voicePresetListResponseSchema = z.object({
  presets: z.array(voicePresetSchema),
  activeId: z.string().nullable(),
});

/** 新建语音配置预设请求 */
export const voiceCreatePresetRequestSchema = z.object({
  name: z.string().min(1).max(32),
  kind: z.enum(["local", "remote", "input"]).optional(),
});

export type VoicePreset = z.infer<typeof voicePresetSchema>;
export type VoicePresetListResponse = z.infer<typeof voicePresetListResponseSchema>;
export type VoiceCreatePresetRequest = z.infer<typeof voiceCreatePresetRequestSchema>;

export const createPersonaRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  config: personaRevisionConfigSchema,
});
export const updatePersonaRequestSchema = z.object({
  expectedRevision: z.number().int().positive(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  config: personaRevisionConfigSchema,
});
export const activatePersonaRequestSchema = z.object({ revisionId: z.string().min(1).optional() });
export const importPersonaRequestSchema = z.object({
  bundleBase64: z.string().min(1),
  conflictResolution: z.enum(["error", "replace"]).default("error"),
});
export const importSkillsRequestSchema = z.object({
  zipBase64: z.string().min(1),
  conflictResolution: z.enum(["error", "replace"]).default("error"),
});
export const exportSkillsRequestSchema = z.object({ names: z.array(z.string().min(1)).optional() });

export const personaBundleResponseSchema = z.object({
  bundleBase64: z.string().min(1),
  fileName: z.string().min(1),
  skillNames: z.array(z.string()),
  missingDependencies: z.array(z.string()),
});
export const skillZipResponseSchema = z.object({
  bundleBase64: z.string().min(1),
  fileName: z.string().min(1),
  skillNames: z.array(z.string()),
});

// ---- CAP-019: 模板审核、回滚、切换历史、记忆范围 ----

/** 提交人格审核请求 */
export const reviewPersonaRequestSchema = z.object({
  reviewStatus: z.enum(["pending_review", "approved", "rejected"]),
  reviewNotes: z.string().max(2000).optional(),
});

/** 人格回滚请求 */
export const rollbackPersonaRequestSchema = z.object({
  revisionId: z.string().min(1),
  /** 回滚时的回归评估备注 */
  regressionNotes: z.string().max(2000).optional(),
});

/** 更新人格记忆范围请求 */
export const updateMemoryScopeRequestSchema = z.object({
  memoryPolicy: memoryPolicySchema,
  /** 共享目标人格 ID 列表 */
  sharedPersonaIds: z.array(z.string().min(1)).optional(),
  /** 共享的记忆类别 */
  sharedCategories: z.array(memoryCategorySchema).optional(),
  /** 用户确认共享范围 */
  confirmed: z.boolean().default(false),
});

/** 人格切换日志响应 */
export const personaSwitchLogSchema = z.object({
  id: z.string().min(1),
  personaId: z.string().min(1),
  revisionId: z.string().min(1),
  previousPersonaId: z.string().nullable(),
  previousRevisionId: z.string().nullable(),
  switchReason: switchReasonSchema,
  regressionNotes: z.string().nullable(),
  switchedAt: z.iso.datetime(),
});

/** 人格记忆范围响应 */
export const personaMemoryScopeSchema = z.object({
  personaId: z.string().min(1),
  memoryPolicy: memoryPolicySchema,
  sharedPersonaIds: z.array(z.string()),
  sharedCategories: z.array(z.string()),
  confirmedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
