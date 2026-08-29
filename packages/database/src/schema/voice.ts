/**
 * Aervox｜思隅 @aervox/database — 语音输出配置持久化（系统核心能力 · 本地语音模型配置）
 *
 * 规则依据：docs/reference/voice/*（阶段 1：WebUI 设置中配置本地语音模型，CR-011）。
 *
 * voice_configs：工作区+用户作用域的本地语音模型配置，每租户一行。用于保存
 * gpt-sovits-local 本地模型的 provider/modelPath/modelId/speakerId 等运行时配置，
 * 使其可从 WebUI 设置中读写并在保存后同步到本地 provider（reconfigure）。
 */
import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

/** 本地语音模型配置快照（租户级；每租户一行） */
export const voiceConfigs = sqliteTable(
  "voice_configs",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    /** 是否启用语音输出（0/1） */
    enabled: integer("enabled").notNull().default(1),
    /** provider 标识，本地固定为 gpt-sovits-local */
    providerId: text("provider_id").notNull(),
    /** 本地模型路径（受 allowedRoots 白名单约束，可为空表示未配置） */
    modelPath: text("model_path"),
    /** 本地模型 ID */
    modelId: text("model_id").notNull(),
    /** 音色 ID（为空表示使用模型默认音色） */
    speakerId: text("speaker_id"),
    /** 扩展设置（JSON 对象） */
    settingsJson: text("settings_json", { mode: "json" }).notNull().default({}),
    ...timestampColumns,
  },
  (table) => ({
    tenantUniqueIdx: uniqueIndex("voice_configs_tenant_unique_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
  }),
);

/** 离线语音输入 (ASR) 配置快照（租户级；每租户一行，CR-016） */
export const voiceInputConfigs = sqliteTable(
  "voice_input_configs",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    /** 是否启用语音输入（0/1） */
    enabled: integer("enabled").notNull().default(1),
    /** 引擎类型：sensevoice-local | whisper-compatible */
    engineType: text("engine_type").notNull().default("sensevoice-local"),
    /** 本地模型路径（受 allowedRoots 白名单约束） */
    modelPath: text("model_path"),
    /** 模型标识（如 sensevoice-small） */
    modelId: text("model_id").notNull().default("sensevoice-small"),
    /** 远程/本地兼容端点 URL（whisper-compatible 模式使用） */
    endpoint: text("endpoint"),
    /** 访问密钥 */
    apiKey: text("api_key"),
    /** 键盘输入自动停止录音（0/1） */
    autoStopOnKeyboard: integer("auto_stop_on_keyboard").notNull().default(1),
    /** 静音断句门限毫秒（默认 700ms） */
    vadSilenceThresholdMs: integer("vad_silence_threshold_ms").notNull().default(700),
    /** 扩展设置（JSON 对象） */
    settingsJson: text("settings_json", { mode: "json" }).notNull().default({}),
    ...timestampColumns,
  },
  (table) => ({
    tenantUniqueIdx: uniqueIndex("voice_input_configs_tenant_unique_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
  }),
);

/** 在线语音模型（GPT-SoVITS 远程 API）配置快照（租户级；每租户一行，CR-028） */
export const voiceRemoteConfigs = sqliteTable(
  "voice_remote_configs",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    /** 是否启用在线语音输出（0/1） */
    enabled: integer("enabled").notNull().default(1),
    /** provider 标识，在线固定为 gpt-sovits-remote */
    providerId: text("provider_id").notNull().default("gpt-sovits-remote"),
    /** api_v2 服务 base URL（如 http://127.0.0.1:9880） */
    endpoint: text("endpoint").notNull(),
    /** 访问密钥（为空表示服务未开启鉴权） */
    apiKey: text("api_key"),
    /** 模型标识（GPT-SoVITS 侧按服务端已加载权重合成，此字段仅作展示与选择标识） */
    modelId: text("model_id").notNull(),
    /** 音色标识（可空） */
    speakerId: text("speaker_id"),
    /** api_v2 text_lang 参数（auto/zh/en/ja/ko/yue） */
    textLang: text("text_lang"),
    /** api_v2 参考音频路径（GPT-SoVITS 机器上的路径） */
    refAudioPath: text("ref_audio_path"),
    /** api_v2 辅助参考音频路径列表（JSON 数组） */
    auxRefAudioPathsJson: text("aux_ref_audio_paths_json", { mode: "json" }),
    /** api_v2 语速（0.6–1.65） */
    speedFactor: real("speed_factor"),
    /** 扩展设置（JSON 对象） */
    settingsJson: text("settings_json", { mode: "json" }).notNull().default({}),
    ...timestampColumns,
  },
  (table) => ({
    tenantUniqueIdx: uniqueIndex("voice_remote_configs_tenant_unique_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
  }),
);