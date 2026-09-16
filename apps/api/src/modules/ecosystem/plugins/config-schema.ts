/**
 * Aervox｜思隅 @aervox/api — 插件 Config Schema 解析与值校验（CAP-020 扩展 · CR-006）
 *
 * 纯函数工具：解析 Aervox v1 DSL、填充默认值、递归校验配置值、Schema 升级 diff。
 * 参考 AstrBot `_conf_schema.json` 的公开设计（AGPLv3，仅借鉴设计、不复制代码）。
 */
import type { PluginConfigField } from "@aervox/contracts";
import { pluginConfigSchema } from "@aervox/contracts";

export interface ConfigIssue {
  key: string;
  code: string;
  message: string;
}

export const MAX_DEPTH = 5;

/** 解析并校验 Config Schema（含递归深度限制） */
export function parseConfigSchema(input: unknown): PluginConfigField[] {
  const parsed = pluginConfigSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(first ? `${first.path.join(".")}: ${first.message}` : "invalid config schema");
  }
  for (const field of parsed.data.fields) {
    assertDepth(field, 1);
  }
  return parsed.data.fields;
}

function assertDepth(field: PluginConfigField, depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new Error(`field "${field.key}" exceeds max nesting depth ${MAX_DEPTH}`);
  }
  for (const child of field.children ?? []) assertDepth(child, depth + 1);
  if (field.items) assertDepth(field.items, depth + 1);
}

/** 依据 Schema 生成默认值对象（secret 无默认；array 默认 []；object 递归） */
export function applyDefaults(fields: PluginConfigField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.type === "secret") continue;
    if (field.default !== undefined) {
      out[field.key] = deepClone(field.default);
    } else if (field.type === "object") {
      out[field.key] = applyDefaults(field.children ?? []);
    } else if (field.type === "array") {
      out[field.key] = [];
    } else if (field.type === "boolean") {
      out[field.key] = false;
    } else if (field.type === "integer" || field.type === "number") {
      out[field.key] = 0;
    } else if (field.type === "multi_select") {
      out[field.key] = [];
    } else {
      out[field.key] = "";
    }
  }
  return out;
}

/** 校验并规范化配置值（返回问题列表 + 清洗后的值；不校验 secret） */
export function validateValues(
  fields: PluginConfigField[],
  values: Record<string, unknown>,
  baseKey = "",
): { issues: ConfigIssue[]; values: Record<string, unknown> } {
  const issues: ConfigIssue[] = [];
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = baseKey ? `${baseKey}.${field.key}` : field.key;
    const raw = values[field.key];
    const isMissing = raw === undefined;

    if (field.type === "secret") {
      // secret 不参与普通值校验；由保存请求的 secretValues 单独处理
      continue;
    }
    if (isMissing || raw === null) {
      if (field.required) {
        issues.push({ key, code: "REQUIRED", message: `缺少必填字段 ${key}` });
      }
      continue;
    }

    let value = raw;
    if (field.type === "integer") {
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        issues.push({ key, code: "TYPE", message: `${key} 必须是整数` });
        continue;
      }
    } else if (field.type === "number") {
      if (typeof raw !== "number") {
        issues.push({ key, code: "TYPE", message: `${key} 必须是数字` });
        continue;
      }
    } else if (field.type === "boolean") {
      if (typeof raw !== "boolean") {
        issues.push({ key, code: "TYPE", message: `${key} 必须是布尔值` });
        continue;
      }
    } else if (field.type === "string" || field.type === "text") {
      if (typeof raw !== "string") {
        issues.push({ key, code: "TYPE", message: `${key} 必须是字符串` });
        continue;
      }
    } else if (field.type === "select") {
      const allowed = field.options?.map((o) => String(o.value)) ?? [];
      if (!allowed.includes(String(raw))) {
        issues.push({ key, code: "OPTION", message: `${key} 不在可选范围内` });
        continue;
      }
    } else if (field.type === "multi_select") {
      if (!Array.isArray(raw)) {
        issues.push({ key, code: "TYPE", message: `${key} 必须是数组` });
        continue;
      }
      const allowed = new Set(field.options?.map((o) => String(o.value)) ?? []);
      for (const item of raw) {
        if (!allowed.has(String(item))) {
          issues.push({ key, code: "OPTION", message: `${key} 包含未知选项 ${String(item)}` });
        }
      }
    } else if (field.type === "object") {
      if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
        issues.push({ key, code: "TYPE", message: `${key} 必须是对象` });
        continue;
      }
      const nested = validateValues(field.children ?? [], raw as Record<string, unknown>, key);
      issues.push(...nested.issues);
      value = nested.values;
    } else if (field.type === "array") {
      if (!Array.isArray(raw)) {
        issues.push({ key, code: "TYPE", message: `${key} 必须是数组` });
        continue;
      }
      const items: unknown[] = [];
      const itemField = field.items;
      raw.forEach((item, index) => {
        if (!itemField) return;
        if (itemField.type === "object") {
          if (typeof item !== "object" || item === null || Array.isArray(item)) {
            issues.push({ key: `${key}[${index}]`, code: "TYPE", message: `${key}[${index}] 必须是对象` });
            return;
          }
          const nested = validateValues([itemField], item as Record<string, unknown>, `${key}[${index}]`);
          issues.push(...nested.issues);
          items.push(nested.values[itemField.key]);
          return;
        }
        const nested = validateValues([itemField], { [itemField.key]: item }, `${key}[${index}]`);
        issues.push(...nested.issues);
        if (nested.values[itemField.key] !== undefined) items.push(nested.values[itemField.key]);
      });
      value = items;
    }

    const v = field.validation;
    if (v) {
      if (typeof value === "string") {
        if (v.minLength !== undefined && value.length < v.minLength) {
          issues.push({ key, code: "MIN_LENGTH", message: `${key} 长度不能小于 ${v.minLength}` });
        }
        if (v.maxLength !== undefined && value.length > v.maxLength) {
          issues.push({ key, code: "MAX_LENGTH", message: `${key} 长度不能超过 ${v.maxLength}` });
        }
        if (v.pattern) {
          try {
            if (!new RegExp(v.pattern).test(value)) {
              issues.push({ key, code: "PATTERN", message: `${key} 格式不正确` });
            }
          } catch {
            // 无效正则按未配置处理（Schema 解析阶段已约束，防御性兜底）
          }
        }
      }
      if (typeof value === "number") {
        if (v.min !== undefined && value < v.min) {
          issues.push({ key, code: "MIN", message: `${key} 不能小于 ${v.min}` });
        }
        if (v.max !== undefined && value > v.max) {
          issues.push({ key, code: "MAX", message: `${key} 不能大于 ${v.max}` });
        }
      }
    }

    out[field.key] = value;
  }
  return { issues, values: out };
}

/** Schema 升级 diff：新增字段补默认值，已移除字段进 orphaned（不静默丢弃） */
export function diffSchema(
  fields: PluginConfigField[],
  previousValues: Record<string, unknown>,
): { defaults: Record<string, unknown>; orphaned: Record<string, unknown> } {
  const known = new Set(fields.map((f) => f.key));
  const defaults = applyDefaults(fields);
  for (const [key, value] of Object.entries(previousValues)) {
    if (!known.has(key)) {
      continue; // orphaned 单独收集
    }
    defaults[key] = value;
  }
  const orphaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(previousValues)) {
    if (!known.has(key)) orphaned[key] = deepClone(value);
  }
  return { defaults, orphaned };
}

/** 取字段本地化文案（字符串直用，否则按 locale 回退 zh-CN/首键） */
export function resolveI18n(
  value: string | Record<string, string> | undefined,
  locale = "zh-CN",
  fallback = "",
): string {
  if (value === undefined) return fallback;
  if (typeof value === "string") return value;
  if (value[locale]) return value[locale];
  return value["zh-CN"] ?? Object.values(value)[0] ?? fallback;
}

function deepClone(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}
