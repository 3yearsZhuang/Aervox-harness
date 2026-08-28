/**
 * Aervox｜思隅 @aervox/database — 大语言模型与供应商配置持久化
 *
 * 规则依据：docs/reference/adr/ADR-005-provider-port.md（CR-012）。
 *
 * llm_configs：工作区+用户作用域的大语言模型与供应商配置，每租户一行。
 * 支持配置 providerType / baseUrl / apiKey / modelId / temperature / maxTokens 等运行时参数。
 */
import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tenantColumns, timestampColumns } from "./common.js";

/** 大语言模型与供应商配置快照（租户级；每租户一行） */
export const llmConfigs = sqliteTable(
  "llm_configs",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    /** 是否启用自定义模型配置（0/1） */
    enabled: integer("enabled").notNull().default(1),
    /** 供应商类型（如 ollama, deepseek, openai, anthropic, custom_openai） */
    providerType: text("provider_type").notNull().default("ollama"),
    /** 服务基址 URL */
    baseUrl: text("base_url").notNull(),
    /** 访问密钥 / Token（本地 Ollama 可空） */
    apiKey: text("api_key"),
    /** 模型标识（如 llama3.2, deepseek-chat, gpt-4o 等） */
    modelId: text("model_id").notNull(),
    /** 生成温度（0.0 ~ 2.0） */
    temperature: real("temperature").notNull().default(0.7),
    /** 最大输出 Token 数 */
    maxTokens: integer("max_tokens").default(4096),
    /** 扩展设置（JSON 对象） */
    settingsJson: text("settings_json", { mode: "json" }).notNull().default({}),
    ...timestampColumns,
  },
  (table) => ({
    tenantUniqueIdx: uniqueIndex("llm_configs_tenant_unique_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ),
  }),
);
