import { nativeContract, type NativeMethods } from "./generated/protocol.js";

export type NativeMethod = keyof NativeMethods;
export type NativeParams<M extends NativeMethod> = NativeMethods[M]["params"];
export type NativeResult<M extends NativeMethod> = NativeMethods[M]["result"];
export type { NativeError, ActivityLease, ActivityCapture, ActivityProbe, ActivityRecord } from "./generated/protocol.js";
export const NATIVE_PROTOCOL = nativeContract.protocol;
export const NATIVE_LIMITS = nativeContract.limits;

interface Schema {
  $ref?: string;
  type?: string | readonly string[];
  const?: unknown;
  enum?: readonly unknown[];
  properties?: Readonly<Record<string, Schema>>;
  required?: readonly string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  maxItems?: number;
  minLength?: number;
  minimum?: number;
  maximum?: number;
}
const definitions: Readonly<Record<string, Schema>> = nativeContract.$defs;

/** Validates only the vocabulary accepted by the generator; input never supplies schemas. */
function matches(schema: Schema, value: unknown): boolean {
  if (schema.$ref) return matches(definitions[schema.$ref.slice("#/$defs/".length)]!, value);
  if (Object.hasOwn(schema, "const")) return value === schema.const;
  if (schema.enum) return schema.enum.includes(value);
  if (Array.isArray(schema.type)) return schema.type.some(type => matches({ ...schema, type }, value));
  switch (schema.type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "string": {
      if (typeof value !== "string") return false;
      if (!schema.minLength) return true;
      let length = 0;
      for (const _character of value) if (++length >= schema.minLength) return true;
      return false;
    }
    case "integer": case "number":
      return typeof value === "number" && Number.isFinite(value) && (schema.type !== "integer" || Number.isSafeInteger(value))
        && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
    case "array": return Array.isArray(value) && (schema.maxItems === undefined || value.length <= schema.maxItems)
      && value.every(item => matches(schema.items!, item));
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      if (schema.required?.some(key => !Object.hasOwn(record, key))) return false;
      return Object.entries(record).every(([key, item]) => {
        const field = Object.hasOwn(schema.properties ?? {}, key) ? schema.properties![key] : undefined;
        return field ? matches(field, item) : typeof schema.additionalProperties === "object"
          ? matches(schema.additionalProperties, item) : schema.additionalProperties !== false;
      });
    }
    default: return false;
  }
}

export function matchesNativePayload(method: string, side: "params" | "result", value: unknown): boolean {
  if (!Object.hasOwn(nativeContract.methods, method)) return false;
  return matches(nativeContract.methods[method as NativeMethod][side], value);
}

export function assertNativeParams(method: string, params: unknown): void {
  if (!matchesNativePayload(method, "params", params)) throw new Error("native_request_invalid");
}

export function decodeNativeResponse(method: string, id: number, value: unknown): { result: unknown } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("native_response_invalid");
  const response = value as Record<string, unknown>;
  if (response.id !== id || Object.keys(response).length !== 2) throw new Error("native_response_invalid");
  if (Object.hasOwn(response, "error") && typeof response.error === "string" && (nativeContract.errors as readonly string[]).includes(response.error)) return { error: response.error };
  if (Object.hasOwn(response, "result") && matchesNativePayload(method, "result", response.result)) return { result: response.result };
  throw new Error("native_response_invalid");
}
