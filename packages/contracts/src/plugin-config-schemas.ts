/**
 * Aervox｜思隅 @aervox/contracts — 插件 Config 与 Page 契约（CAP-020 扩展）
 *
 * 规则依据：docs/reference/plugin-config-and-pages.md（CR-006）。
 * 参考 AstrBot `_conf_schema.json` 与 Plugin Pages 的公开设计（AGPLv3，仅借鉴设计、不复制代码），
 * 但以 Aervox 自有版本化 DSL 作为运行时唯一事实源，不做 AstrBot 格式兼容导入。
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

// 必须在任何 schema 创建前调用（与 schemas.ts 保持相同约定）
extendZodWithOpenApi(z);

/** 配置字段类型（v1 支持集合） */
export const pluginConfigFieldTypeSchema = z.enum([
  "string",
  "text",
  "integer",
  "number",
  "boolean",
  "select",
  "multi_select",
  "object",
  "array",
  "secret",
]);

/** visibleWhen 操作符（仅控制界面显隐，不承担权限控制） */
export const pluginConfigVisibleWhenOperatorSchema = z.enum([
  "equals",
  "not_equals",
  "in",
  "not_in",
  "truthy",
  "falsy",
]);

export const pluginConfigVisibleWhenSchema = z.object({
  field: z.string().min(1).max(128),
  operator: pluginConfigVisibleWhenOperatorSchema,
  value: z.unknown().optional(),
});

/** 字段校验声明（服务端校验 + UI 行级错误） */
export const pluginConfigValidationSchema = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    minLength: z.number().int().nonnegative().optional(),
    maxLength: z.number().int().positive().optional(),
    pattern: z.string().optional(),
  })
  .strict();

/** 选择项（select / multi_select 必须使用结构化选项） */
export const pluginConfigOptionSchema = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]),
  label: z.string().min(1),
});

/** 字段校验声明（服务端校验 + UI 行级错误） */
export interface PluginConfigValidation {
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

/** 选择项（select / multi_select 必须使用结构化选项） */
export interface PluginConfigOption {
  value: string | number | boolean;
  label: string;
}

/** 递归字段定义（最大嵌套深度 5，由解析器强制） */
export interface PluginConfigField {
  key: string;
  type: "string" | "text" | "integer" | "number" | "boolean" | "select" | "multi_select" | "object" | "array" | "secret";
  label: string | Record<string, string>;
  description?: string | Record<string, string>;
  hint?: string | Record<string, string>;
  placeholder?: string | Record<string, string>;
  default?: unknown;
  required?: boolean;
  options?: PluginConfigOption[];
  /** object 类型的子字段 */
  children?: PluginConfigField[];
  /** array 类型的元素字段（单一元素 schema） */
  items?: PluginConfigField;
  validation?: PluginConfigValidation;
  visibleWhen?: {
    field: string;
    operator: "equals" | "not_equals" | "in" | "not_in" | "truthy" | "falsy";
    value?: unknown;
  };
}

export const pluginConfigFieldSchema: z.ZodType<PluginConfigField> = z.lazy(() =>
  z
    .object({
      key: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, "field key must match [A-Za-z0-9_-]+"),
      type: pluginConfigFieldTypeSchema,
      label: z.union([z.string().min(1), z.record(z.string(), z.string())]),
      description: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
      hint: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
      placeholder: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
      default: z.unknown().optional(),
      required: z.boolean().default(false),
      options: z.array(pluginConfigOptionSchema).optional(),
      /** object 类型的子字段 */
      children: z.array(pluginConfigFieldSchema).optional(),
      /** array 类型的元素字段（单一元素 schema） */
      items: pluginConfigFieldSchema.optional(),
      validation: pluginConfigValidationSchema.optional(),
      visibleWhen: pluginConfigVisibleWhenSchema.optional(),
    })
    .strict()
    .refine(
      (field) => {
        if (field.type === "object") return field.children !== undefined;
        if (field.type === "array") return field.items !== undefined;
        if (field.type === "select" || field.type === "multi_select") {
          return field.options !== undefined && field.options.length > 0;
        }
        return true;
      },
      { message: "object 需要 children，array 需要 items，select/multi_select 需要 options" },
    ),
);

/** Aervox 插件 Config Schema v1（Bundle 内 config.schema.json 的运行时事实源） */
export const pluginConfigSchema = z
  .object({
    apiVersion: z.literal("aervox.dev/v1"),
    kind: z.literal("PluginConfigSchema"),
    schemaVersion: z.literal(1),
    fields: z.array(pluginConfigFieldSchema).max(200),
  })
  .strict();

/** OpenAPI 生成用简化 Config Schema（zod-to-openapi 不支持 z.lazy 递归，运行时校验仍用 pluginConfigSchema） */
export const pluginConfigSchemaOpenApi = z
  .object({
    apiVersion: z.literal("aervox.dev/v1"),
    kind: z.literal("PluginConfigSchema"),
    schemaVersion: z.literal(1),
    fields: z.array(z.record(z.string(), z.unknown())).max(200),
  })
  .strict();

/** 插件 Page 元数据 */
export const pluginPageSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, "page id must match [A-Za-z0-9_-]+"),
  title: z.union([z.string().min(1), z.record(z.string(), z.string())]),
  description: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  /** Bundle 内相对入口（如 pages/dashboard/index.html） */
  entry: z.string().min(1).max(512),
  /** Page 能力声明（宿主按声明放行 Bridge 动作） */
  capabilities: z
    .array(z.enum(["config.read", "config.write", "host.notify", "host.close"]))
    .default([]),
  checksum: z.string().optional(),
});

/**
 * 插件主动智能感知源声明（CR-032 §4.1）。
 * 授权门控：用户须在扩展中心授予 plugin_grants（permission=PLUGIN_SENSOR_PERMISSION，
 * scope=sourceId），内核在未授权时切断该感知源的一切事件输入（fail-closed）。
 */
export const pluginProactiveSensorSchema = z
  .object({
    sourceId: z.string().min(1).max(128),
    description: z.string().max(500).optional(),
  })
  .strict();

/** 内核具备求值器的触发类型（未知类型在清单校验期即拒绝，杜绝永不触发的死规则） */
export const pluginProactiveTriggerTypeSchema = z.enum([
  "system_state",
  "fatigue_high",
  "drift_high",
  "health_sleep_low",
  "commitment_due",
]);

/** 插件主动触发规则声明；cooldown / quietHours / 频次水位由内核裁决器统一实施 */
export const pluginProactiveTriggerSchema = z
  .object({
    ruleId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, "ruleId must match [A-Za-z0-9_-]+"),
    name: z.string().min(1).max(128),
    triggerType: pluginProactiveTriggerTypeSchema,
    /** 类型相关条件（system_state: idleMinutesMax / continuousActiveMinutesMin），求值期 fail-closed */
    condition: z.record(z.string(), z.unknown()).default({}),
    cooldownSeconds: z.number().int().min(0).max(7 * 24 * 3600).default(1800),
    quietHoursPolicy: z.enum(["respect_global", "bypass"]).default("respect_global"),
    /** 桌宠表现声明（动画别名 + 气泡预设），由桌面端解析，未知值安全降级 */
    petPresentation: z
      .object({
        animation: z.string().min(1).max(64).optional(),
        bubblePreset: z.string().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** 插件主动智能声明命名空间（可选；未声明即为传统被动插件，行为完全不变） */
export const pluginProactiveSpecSchema = z
  .object({
    sensors: z.array(pluginProactiveSensorSchema).max(20).default([]),
    triggers: z.array(pluginProactiveTriggerSchema).max(20).default([]),
  })
  .strict();

export interface PluginProactiveSensor {
  sourceId: string;
  description?: string;
}

export interface PluginProactiveTrigger {
  ruleId: string;
  name: string;
  triggerType: "system_state" | "fatigue_high" | "drift_high" | "health_sleep_low" | "commitment_due";
  condition: Record<string, unknown>;
  cooldownSeconds: number;
  quietHoursPolicy: "respect_global" | "bypass";
  petPresentation?: {animation?: string; bubblePreset?: string};
}

export interface PluginProactiveSpec {
  sensors: PluginProactiveSensor[];
  triggers: PluginProactiveTrigger[];
}

/** 插件感知源授权约定：plugin_grants.permission 的固定值，scope 存 sourceId */
export const PLUGIN_SENSOR_PERMISSION = "proactive.sensor" as const;

/** 插件 Bundle Manifest v1 */
export const pluginManifestSchema = z.object({
  apiVersion: z.literal("aervox.dev/v1"),
  kind: z.literal("PluginManifest"),
  metadata: z.object({
    id: z.string().min(1).max(128),
    displayName: z.string().min(1).max(128),
    publisher: z.string().min(1).max(128),
    version: z.string().min(1).max(64),
    description: z.string().max(2000).optional(),
    license: z.string().max(128).optional(),
  }),
  spec: z
    .object({
      config: z
        .object({
          schemaVersion: z.literal(1),
          entry: z.string().min(1).max(512).default("config.schema.json"),
        })
        .optional(),
      pages: z.array(pluginPageSchema).max(50).optional(),
      /** 绑定的 MCP 服务预设 id（CAP-020 / ADR-010） */
      mcpServers: z.array(z.string().min(1).max(128)).max(20).optional(),
      /** Bundle 内技能入口（默认 SKILL.md），用于主动回合装配插件专有心智 */
      skill: z.string().min(1).max(512).optional(),
      /** 主动智能声明命名空间（CR-032） */
      proactive: pluginProactiveSpecSchema.optional(),
    })
    .default({}),
});

/** 配置快照（API 返回形态；secret 只返回配置状态，永不返回明文） */
export const pluginConfigIssueSchema = z.object({
  key: z.string(),
  code: z.string(),
  message: z.string(),
});

export const pluginConfigSnapshotSchema = z.object({
  pluginId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  schemaVersion: z.number().int().nonnegative(),
  values: z.record(z.string(), z.unknown()).default({}),
  secretFields: z.record(z.string(), z.object({ configured: z.boolean() })).default({}),
  orphanedValues: z.record(z.string(), z.unknown()).default({}),
  issues: z.array(pluginConfigIssueSchema).default([]),
});

/** 配置更新请求（revision CAS；secretValues 缺失字段=保持不变，null=清除） */
export const pluginConfigUpdateRequestSchema = z.object({
  revision: z.number().int().nonnegative(),
  values: z.record(z.string(), z.unknown()).default({}),
  secretValues: z.record(z.string(), z.union([z.string(), z.null()])).default({}),
});

/** Page 资源写入请求（base64 内容） */
export const pluginPageAssetSchema = z.object({
  /** Bundle 内相对路径（如 app.js、style.css、assets/logo.svg） */
  path: z.string().min(1).max(512),
  contentBase64: z.string().min(1),
});

export const pluginPageAssetsRequestSchema = z.object({
  files: z.array(pluginPageAssetSchema).max(200),
});

/** Page Bridge 初始上下文（宿主注入 iframe） */
export const pluginPageContextSchema = z.object({
  pluginId: z.string().min(1),
  displayName: z.string(),
  pageId: z.string().min(1),
  locale: z.string().default("zh-CN"),
  theme: z.enum(["light", "dark"]).default("light"),
  capabilities: z.array(z.enum(["config.read", "config.write", "host.notify", "host.close"])).default([]),
  revision: z.number().int().nonnegative().default(0),
});

/** Page Bridge 保存配置输入 */
export const pluginPageSaveConfigSchema = z.object({
  values: z.record(z.string(), z.unknown()).default({}),
  secretValues: z.record(z.string(), z.union([z.string(), z.null()])).default({}),
});
