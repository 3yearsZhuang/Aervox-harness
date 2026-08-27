/**
 * Aervox｜思隅 @aervox/database — 语音输出配置持久化（系统核心能力 · 本地语音模型配置）
 *
 * 规则依据：docs/reference/voice/*（阶段 1：WebUI 设置中配置本地语音模型，CR-011）。
 *
 * voice_configs：工作区+用户作用域的本地语音模型配置，每租户一行。用于保存
 * gpt-sovits-local 本地模型的 provider/modelPath/modelId/speakerId 等运行时配置，
 * 使其可从 WebUI 设置中读写并在保存后同步到本地 provider（reconfigure）。
 */
import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";
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