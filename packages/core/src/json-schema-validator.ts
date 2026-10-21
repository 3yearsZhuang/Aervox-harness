/**
 * Zero-runtime-dependency JSON Schema subset for tool arguments.
 * Unsupported assertion keywords fail closed, including inside unused branches.
 * JSON values, schema traversal and evaluation are bounded; this is not a full
 * JSON Schema implementation. See the tool contract for the supported subset.
 */
import type { ToolValidationErrorDetail, ToolValidationResult } from "./types.js";

type Schema = boolean | Record<string, unknown>;
type Errors = ToolValidationErrorDetail[];
interface Budget { steps: number }
const MAX_DEPTH = 64;
const MAX_STEPS = 20_000;
const MAX_ERRORS = 100;
const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
const ANNOTATIONS = new Set([
  "$schema", "$id", "$comment", "title", "description", "default", "examples",
  "deprecated", "readOnly", "writeOnly",
]);
const COUNTS = new Set(["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"]);
const NUMBERS = new Set(["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
const COMBINATORS = new Set(["anyOf", "oneOf", "allOf"]);
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const childPath = (path: string, key: string) => path ? `${path}.${key}` : key;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

class ValidationFailure extends Error {
  constructor(readonly detail: ToolValidationErrorDetail) { super(detail.message); }
}
function fail(path: string, keyword: string, message: string): never {
  throw new ValidationFailure({ path: path || "(root)", keyword, message });
}
function step(budget: Budget, depth: number, path: string): void {
  if (++budget.steps > MAX_STEPS || depth > MAX_DEPTH) {
    fail(path, "validation_limit", `validation exceeds ${MAX_STEPS} steps or ${MAX_DEPTH} levels`);
  }
}
function add(errors: Errors, path: string, keyword: string, message: string): void {
  if (errors.length < MAX_ERRORS) errors.push({ path: path || "(root)", keyword, message });
}

// Reject non-JSON numbers, cycles, sparse arrays and accessors before evaluating
// an open schema. Shared (non-cyclic) objects are allowed and consume the budget.
function checkJson(value: unknown, path: string, budget: Budget, active: Set<object>, depth = 0): void {
  step(budget, depth, path);
  if (typeof value === "string") {
    // Charge text before equality or Unicode scans, including open schemas and
    // metadata. A single huge scalar must not bypass the traversal budget.
    budget.steps += value.length;
    if (budget.steps > MAX_STEPS) fail(path, "validation_limit", `validation exceeds ${MAX_STEPS} steps or ${MAX_DEPTH} levels`);
    return;
  }
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null) {
    fail(path, "json_value", "value must be a finite JSON value");
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    fail(path, "json_value", "objects must have a plain JSON prototype");
  }
  if (active.has(value)) fail(path, "json_value", "cyclic values are not JSON");
  active.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !own(descriptor, "value")) fail(`${path}[${i}]`, "json_value", "array entries must be JSON values");
      checkJson(descriptor.value, `${path}[${i}]`, budget, active, depth + 1);
    }
  } else {
    for (const key of Object.keys(value)) {
      budget.steps += key.length;
      if (budget.steps > MAX_STEPS) fail(path, "validation_limit", `validation exceeds ${MAX_STEPS} steps or ${MAX_DEPTH} levels`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!own(descriptor, "value")) fail(childPath(path, key), "json_value", "accessors are not JSON values");
      checkJson(descriptor.value, childPath(path, key), budget, active, depth + 1);
    }
  }
  active.delete(value);
}

function inspectSchema(schema: unknown, path: string, budget: Budget, depth = 0): asserts schema is Schema {
  step(budget, depth, path);
  if (typeof schema === "boolean") return;
  if (!isObject(schema)) fail(path, "invalid_schema", "schema must be an object or boolean");
  const invalid = (keyword: string) => fail(path, "invalid_schema", `invalid schema keyword '${keyword}'`);
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key) || key.startsWith("x-")) continue;
    if (key === "type") {
      const types = Array.isArray(value) ? value : [value];
      if (!types.length || types.some((type) => typeof type !== "string" || !TYPES.has(type)) || new Set(types).size !== types.length) invalid(key);
    } else if (key === "properties") {
      if (!isObject(value)) invalid(key);
      for (const [name, subschema] of Object.entries(value as Record<string, unknown>)) {
        inspectSchema(subschema, childPath(path, name), budget, depth + 1);
      }
    } else if (key === "items" || key === "additionalProperties" || key === "not") {
      inspectSchema(value, path, budget, depth + 1);
    } else if (COMBINATORS.has(key)) {
      if (!Array.isArray(value) || !value.length) invalid(key);
      for (const subschema of value as unknown[]) inspectSchema(subschema, path, budget, depth + 1);
    } else if (key === "required") {
      if (!Array.isArray(value) || value.some((name) => typeof name !== "string") || new Set(value).size !== value.length) invalid(key);
    } else if (key === "enum") {
      if (!Array.isArray(value) || !value.length) invalid(key);
      const values = value as unknown[];
      for (let i = 0; i < values.length; i++) {
        for (let j = 0; j < i; j++) {
          if (jsonEqual(values[i], values[j], budget)) invalid(key);
        }
      }
    } else if (key === "const") {
      // JSON-ness, cycles and bounds have already been checked for the whole schema.
    } else if (COUNTS.has(key)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) invalid(key);
    } else if (NUMBERS.has(key)) {
      if (typeof value !== "number" || !Number.isFinite(value) || (key === "multipleOf" && value <= 0)) invalid(key);
    } else if (key === "uniqueItems") {
      if (typeof value !== "boolean") invalid(key);
    } else if (key === "format" && value === "date") {
      // Only the date format currently used by built-in tools is asserted.
    } else {
      fail(path, "unsupported_schema", `unsupported schema keyword '${key}'${key === "format" ? `: ${String(value)}` : ""}`);
    }
  }
}

function jsonEqual(a: unknown, b: unknown, budget: Budget, depth = 0): boolean {
  step(budget, depth, "");
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => jsonEqual(item, b[i], budget, depth + 1));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => own(b, key) && jsonEqual(a[key], b[key], budget, depth + 1));
  }
  return false;
}
function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "null": return value === null;
    case "array": return Array.isArray(value);
    case "object": return isObject(value);
    case "integer": return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    default: return typeof value === type;
  }
}
function isDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}
function checkBound(schema: Record<string, unknown>, key: string, actual: number, errors: Errors, path: string, lower: boolean): void {
  const bound = schema[key];
  if (own(schema, key) && typeof bound === "number" && (lower ? actual < bound : actual > bound)) {
    add(errors, path, key, `value must be ${lower ? ">=" : "<="} ${bound}`);
  }
}

// Compare finite JSON decimal representations exactly. Floating division can
// underflow to zero or round a large non-integer quotient to an apparent match.
function isMultipleOf(value: number, divisor: number): boolean {
  const decimal = (number: number): [bigint, number] => {
    const [mantissa, exponent = "0"] = String(number).split("e");
    const [integer, fraction = ""] = mantissa!.split(".");
    return [BigInt(integer! + fraction), Number(exponent) - fraction.length];
  };
  const [numerator, numeratorExponent] = decimal(value);
  const [denominator, denominatorExponent] = decimal(divisor);
  const difference = numeratorExponent - denominatorExponent;
  return difference >= 0
    ? (numerator * 10n ** BigInt(difference)) % denominator === 0n
    : numerator % (denominator * 10n ** BigInt(-difference)) === 0n;
}

function evaluate(schema: Schema, data: unknown, path: string, budget: Budget, depth = 0): Errors {
  step(budget, depth, path);
  const errors: Errors = [];
  if (schema === true) return errors;
  if (schema === false) {
    add(errors, path, "falseSchema", "value is forbidden by this schema");
    return errors;
  }
  if (own(schema, "type")) {
    const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
    if (!types.some((type) => matchesType(type, data))) {
      add(errors, path, "type", `expected type '${types.join("|")}'`);
      return errors;
    }
  }
  if (own(schema, "enum") && !(schema.enum as unknown[]).some((value) => jsonEqual(value, data, budget))) {
    add(errors, path, "enum", "value must match an enum member");
  }
  if (own(schema, "const") && !jsonEqual(schema.const, data, budget)) add(errors, path, "const", "value must match const");
  for (const key of COMBINATORS) {
    if (!own(schema, key)) continue;
    const branches = schema[key] as Schema[];
    let matching = 0;
    for (const branch of branches) if (evaluate(branch, data, path, budget, depth + 1).length === 0) matching++;
    if ((key === "anyOf" && matching === 0) || (key === "oneOf" && matching !== 1) || (key === "allOf" && matching !== branches.length)) {
      add(errors, path, key, `value does not satisfy '${key}'`);
    }
  }
  if (own(schema, "not") && evaluate(schema.not as Schema, data, path, budget, depth + 1).length === 0) {
    add(errors, path, "not", "value matches a forbidden schema");
  }
  if (typeof data === "string") {
    if (own(schema, "minLength") || own(schema, "maxLength")) {
      let length = 0;
      for (const _codePoint of data) {
        step(budget, depth, path);
        length++;
      }
      checkBound(schema, "minLength", length, errors, path, true);
      checkBound(schema, "maxLength", length, errors, path, false);
    }
    if (own(schema, "format") && schema.format === "date" && !isDate(data)) add(errors, path, "format", "value must be a valid YYYY-MM-DD date");
  } else if (typeof data === "number") {
    checkBound(schema, "minimum", data, errors, path, true);
    checkBound(schema, "maximum", data, errors, path, false);
    if (own(schema, "exclusiveMinimum") && data <= (schema.exclusiveMinimum as number)) add(errors, path, "exclusiveMinimum", `value must be > ${schema.exclusiveMinimum}`);
    if (own(schema, "exclusiveMaximum") && data >= (schema.exclusiveMaximum as number)) add(errors, path, "exclusiveMaximum", `value must be < ${schema.exclusiveMaximum}`);
    if (own(schema, "multipleOf")) {
      if (!isMultipleOf(data, schema.multipleOf as number)) {
        add(errors, path, "multipleOf", `value must be a multiple of ${schema.multipleOf}`);
      }
    }
  } else if (Array.isArray(data)) {
    checkBound(schema, "minItems", data.length, errors, path, true);
    checkBound(schema, "maxItems", data.length, errors, path, false);
    for (let i = 0; i < data.length; i++) {
      if (own(schema, "items")) append(errors, evaluate(schema.items as Schema, data[i], `${path}[${i}]`, budget, depth + 1));
      if (own(schema, "uniqueItems") && schema.uniqueItems === true) {
        for (let j = 0; j < i; j++) {
          if (jsonEqual(data[i], data[j], budget)) {
            add(errors, `${path}[${i}]`, "uniqueItems", "array items must be unique");
            break;
          }
        }
      }
    }
  } else if (isObject(data)) {
    const keys = Object.keys(data);
    checkBound(schema, "minProperties", keys.length, errors, path, true);
    checkBound(schema, "maxProperties", keys.length, errors, path, false);
    for (const required of own(schema, "required") ? schema.required as string[] : []) {
      if (!own(data, required)) add(errors, childPath(path, required), "required", `missing required property '${required}'`);
    }
    const properties = own(schema, "properties") ? schema.properties as Record<string, Schema> : {};
    for (const key of keys) {
      const next = childPath(path, key);
      if (own(properties, key)) append(errors, evaluate(properties[key]!, data[key], next, budget, depth + 1));
      else if (own(schema, "additionalProperties")) {
        if (schema.additionalProperties === false) add(errors, next, "additionalProperties", `unexpected additional property '${key}'`);
        else append(errors, evaluate(schema.additionalProperties as Schema, data[key], next, budget, depth + 1));
      }
    }
  }
  return errors;
}
function append(target: Errors, source: Errors): void {
  target.push(...source.slice(0, MAX_ERRORS - target.length));
}

export function validateJsonSchema(schema: unknown, data: unknown, currentPath = ""): ToolValidationResult {
  // Preserve the port's existing "no schema" convention only at the root.
  if (schema === undefined || schema === null) return { valid: true };
  const budget: Budget = { steps: 0 };
  try {
    checkJson(schema, currentPath, budget, new Set());
    inspectSchema(schema, currentPath, budget);
    checkJson(data, currentPath, budget, new Set());
    const errors = evaluate(schema, data, currentPath, budget);
    return errors.length ? { valid: false, errors } : { valid: true };
  } catch (error) {
    return { valid: false, errors: [error instanceof ValidationFailure ? error.detail : {
      path: currentPath || "(root)", keyword: "invalid_schema", message: "schema or value could not be inspected",
    }] };
  }
}
