/**
 * Aervox｜思隅 @aervox/database — 大语言模型与供应商配置持久化
 *
 * 规则依据：docs/reference/adr/ADR-005-provider-port.md（CR-012）。
 *
 * llm_configs：工作区+用户作用域的大语言模型与供应商配置，每租户多行（多预设）。
 * 每行 = 一个命名预设（name），同一租户至多一个预设 is_active=1（部分唯一索引保证）。
 * 支持配置 providerType / baseUrl / apiKey / modelId / temperature / maxTokens 等运行时参数。
 */
import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { tenantColumns, timestampColumns } from "./common.js";

/** 大语言模型与供应商配置文件预设（租户级；每租户多行，至多一行激活） */
export const llmConfigs = sqliteTable(
  "llm_configs",
  {
    id: text("id").primaryKey(),
    ...tenantColumns,
    /** 预设名称（多预设切换用，默认「默认配置」） */
    name: text("name").notNull().default("默认配置"),
    /** 是否为当前激活预设（0/1；每租户至多一行 =1） */
    isActive: integer("is_active").notNull().default(1),
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
    tenantIdx: index("llm_configs_tenant_idx").on(table.workspaceId, table.subjectUserId),
    tenantActiveIdx: uniqueIndex("llm_configs_tenant_active_idx").on(
      table.workspaceId,
      table.subjectUserId,
    ).where(sql`${table.isActive} = 1`),
  }),
);
