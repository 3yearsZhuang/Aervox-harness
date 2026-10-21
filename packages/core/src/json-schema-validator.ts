/**
 * Aervox｜思隅 @aervox/core — 零依赖 JSON Schema 校验器（白盒工具契约）
 *
 * 针对 ToolSpec 与 HostToolRuntime 的纯 TypeScript 参数校验实现。
 * 覆盖常见的 JSON Schema 子集（type, properties, required, items, enum, min/max, additionalProperties），
 * 严格保持 @aervox/core 零外部运行时依赖的架构原则。
 */
import type { ToolValidationErrorDetail, ToolValidationResult } from "./types.js";

interface JsonSchemaObject {
  type?: string | string[];
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  additionalProperties?: boolean | unknown;
  description?: string;
}

/** JSON Schema enum compares JSON values structurally, independent of object key order. */
function equalJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length
      && left.every((value, index) => equalJson(value, right[index]));
  }
  if (left && right && typeof left === "object" && typeof right === "object" && !Array.isArray(right)) {
    const a = left as Record<string, unknown>;
    const b = right as Record<string, unknown>;
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length
      && keys.every(key => Object.hasOwn(b, key) && equalJson(a[key], b[key]));
  }
  return false;
}

export function validateJsonSchema(schema: unknown, data: unknown, currentPath = ""): ToolValidationResult {
  if (schema === false) return { valid: false, errors: [{ path: currentPath || "(root)", message: "value is forbidden by schema", keyword: "falseSchema" }] };
  // 无 schema 或非对象 schema：视为开放 schema，通过校验
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { valid: true };
  }

  const s = schema as JsonSchemaObject;
  const errors: ToolValidationErrorDetail[] = [];
  const formatPath = (sub: string) => (currentPath ? `${currentPath}.${sub}` : sub);

  // 1. enum 校验（最高优先级）
  if (Array.isArray(s.enum)) {
    if (!s.enum.some((val) => equalJson(val, data))) {
      errors.push({
        path: currentPath || "(root)",
        message: `value must be one of [${s.enum.map((v) => JSON.stringify(v)).join(", ")}]`,
        keyword: "enum",
      });
      return { valid: false, errors };
    }
  }

  // 2. type 校验
  if (s.type) {
    const allowedTypes = Array.isArray(s.type) ? s.type : [s.type];
    const matchType = (expected: string, val: unknown): boolean => {
      switch (expected) {
        case "string":
          return typeof val === "string";
        case "number":
          return typeof val === "number" && Number.isFinite(val);
        case "integer":
          return typeof val === "number" && Number.isInteger(val);
        case "boolean":
          return typeof val === "boolean";
        case "null":
          return val === null;
        case "array":
          return Array.isArray(val);
        case "object":
          return typeof val === "object" && val !== null && !Array.isArray(val);
        default:
          return true;
      }
    };

    const isMatched = allowedTypes.some((t) => matchType(t, data));
    if (!isMatched) {
      errors.push({
        path: currentPath || "(root)",
        message: `expected type '${allowedTypes.join("|")}', received '${data === null ? "null" : Array.isArray(data) ? "array" : typeof data}'`,
        keyword: "type",
      });
      return { valid: false, errors };
    }
  }

  // 3. 针对不同类型的具体属性校验
  if (typeof data === "string") {
    if (typeof s.minLength === "number" && data.length < s.minLength) {
      errors.push({
        path: currentPath || "(root)",
        message: `string length must be >= ${s.minLength}`,
        keyword: "minLength",
      });
    }
    if (typeof s.maxLength === "number" && data.length > s.maxLength) {
      errors.push({
        path: currentPath || "(root)",
        message: `string length must be <= ${s.maxLength}`,
        keyword: "maxLength",
      });
    }
  } else if (typeof data === "number") {
    if (typeof s.minimum === "number" && data < s.minimum) {
      errors.push({
        path: currentPath || "(root)",
        message: `number must be >= ${s.minimum}`,
        keyword: "minimum",
      });
    }
    if (typeof s.maximum === "number" && data > s.maximum) {
      errors.push({
        path: currentPath || "(root)",
        message: `number must be <= ${s.maximum}`,
        keyword: "maximum",
      });
    }
  } else if (Array.isArray(data)) {
    if (typeof s.minItems === "number" && data.length < s.minItems) {
      errors.push({
        path: currentPath || "(root)",
        message: `array length must be >= ${s.minItems}`,
        keyword: "minItems",
      });
    }
    if (typeof s.maxItems === "number" && data.length > s.maxItems) {
      errors.push({
        path: currentPath || "(root)",
        message: `array length must be <= ${s.maxItems}`,
        keyword: "maxItems",
      });
    }
    if (s.items !== undefined) {
      for (let i = 0; i < data.length; i++) {
        const itemRes = validateJsonSchema(s.items, data[i], `${currentPath}[${i}]`);
        if (!itemRes.valid && itemRes.errors) {
          errors.push(...itemRes.errors);
        }
      }
    }
  } else if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, unknown>;

    // required 检查
    if (Array.isArray(s.required)) {
      for (const reqKey of s.required) {
        if (!Object.hasOwn(obj, reqKey) || obj[reqKey] === undefined) {
          errors.push({
            path: formatPath(reqKey),
            message: `missing required property '${reqKey}'`,
            keyword: "required",
          });
        }
      }
    }

    // Only explicitly declared own properties count; Object.prototype is never a schema.
    const properties = s.properties && typeof s.properties === "object" ? s.properties : undefined;
    for (const [key, value] of Object.entries(obj)) {
      const propertySchema = properties && Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (properties && Object.hasOwn(properties, key)) {
        const result = validateJsonSchema(propertySchema, value, formatPath(key));
        if (result.errors) errors.push(...result.errors);
      } else if (s.additionalProperties === false) {
        errors.push({ path: formatPath(key), message: `unexpected additional property '${key}'`, keyword: "additionalProperties" });
      } else if (s.additionalProperties && typeof s.additionalProperties === "object") {
        const result = validateJsonSchema(s.additionalProperties, value, formatPath(key));
        if (result.errors) errors.push(...result.errors);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors: errors.length > 0 ? errors : undefined,
  };
}
