/** Candidate JSON value protocol for an injected native SQLite client. This
 * module neither opens a connection nor exposes a bridge or durable authority.
 * Compatibility follows the pinned @libsql/client 0.14 sqlite3 value/row mapping;
 * malformed protocol data is rejected rather than coerced to a database value.
 */
import type { InValue, IntMode, ResultSet, Row, Value } from "@libsql/client";

export type NativeSqliteValue =
  | { type: "null" }
  | { type: "text"; value: string }
  /** REAL results also preserve infinities; input encoding remains finite. */
  | { type: "float"; value: number | "-0" | "Infinity" | "-Infinity" }
  | { type: "int64"; value: string }
  /** Canonical lowercase hexadecimal, including the empty string for zero bytes. */
  | { type: "blob"; value: string };
export interface NativeSqliteResult {
  columns: string[];
  columnTypes: string[];
  rows: NativeSqliteValue[][];
  rowsAffected: number;
  lastInsertRowid: string | null;
}

const minInt64 = -9223372036854775808n, maxInt64 = 9223372036854775807n;
const minSafe = BigInt(Number.MIN_SAFE_INTEGER), maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
const fail = (): never => { throw new TypeError("Invalid native SQLite value or result"); };
function mode(value: IntMode): void {
  if (value !== "number" && value !== "bigint" && value !== "string") fail();
}
function integer(value: unknown): bigint {
  if (typeof value !== "string" || value.length > 20 || !/^(?:0|-?[1-9][0-9]*)$/.test(value)) return fail();
  const parsed = BigInt(value);
  if (parsed < minInt64 || parsed > maxInt64) return fail();
  return parsed;
}
function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fail();
  return value;
}
function floating(value: number): NativeSqliteValue {
  return { type: "float", value: Object.is(finite(value), -0) ? "-0" : value };
}
function hex(bytes: Uint8Array): string {
  let result = "";
  for (const value of bytes) result += value.toString(16).padStart(2, "0");
  return result;
}
function binary(value: unknown): ArrayBuffer {
  if (typeof value !== "string" || value.length % 2 || !/^[0-9a-f]*$/.test(value)) return fail();
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes.buffer;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) return fail();
  return value as Record<string, unknown>;
}

/** All JS numbers bind as finite REAL values, including integral numbers;
 * bigint binds signed INTEGER. Boolean follows the host's explicit intMode
 * (number=REAL 0/1, bigint=INTEGER, string=TEXT), as pinned libsql does. Date binds
 * its finite epoch milliseconds; undefined and unsupported objects are rejected.
 */
export function encodeNativeSqliteValue(value: InValue, intMode: IntMode = "number"): NativeSqliteValue {
  mode(intMode);
  if (value === null) return { type: "null" };
  if (typeof value === "string") return { type: "text", value };
  if (typeof value === "number") return floating(value);
  if (typeof value === "bigint") {
    integer(value.toString()); return { type: "int64", value: value.toString() };
  }
  if (typeof value === "boolean") return intMode === "bigint"
    ? { type: "int64", value: value ? "1" : "0" }
    : intMode === "string" ? { type: "text", value: value ? "1" : "0" } : { type: "float", value: value ? 1 : 0 };
  if (value instanceof Date) return floating(value.valueOf());
  if (value instanceof ArrayBuffer) return { type: "blob", value: hex(new Uint8Array(value)) };
  if (value instanceof Uint8Array) return { type: "blob", value: hex(value) };
  return fail();
}

export function decodeNativeSqliteValue(input: unknown, intMode: IntMode = "number"): Value {
  mode(intMode);
  const type = input && typeof input === "object" && !Array.isArray(input) && Object.hasOwn(input, "type")
    ? (input as Record<string, unknown>).type : undefined;
  const value = record(input, type === "null" ? ["type"] : ["type", "value"]);
  if (type === "null") return null;
  if (type === "text") { if (typeof value.value !== "string") return fail(); return value.value; }
  if (type === "float") {
    if (value.value === "-0") return -0;
    if (value.value === "Infinity") return Infinity;
    if (value.value === "-Infinity") return -Infinity;
    return finite(value.value);
  }
  if (type === "blob") return binary(value.value);
  if (type === "int64") {
    const parsed = integer(value.value);
    if (intMode === "bigint") return parsed;
    if (intMode === "string") return value.value as string;
    if (parsed < minSafe || parsed > maxSafe) throw new RangeError("Received integer which cannot be safely represented as a JavaScript number");
    return Number(parsed);
  }
  return fail();
}

const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function jsonValue(value: Value): null | string | number {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof ArrayBuffer) {
    const bytes = new Uint8Array(value);
    let output = "";
    for (let index = 0; index < bytes.length; index += 3) {
      const a = bytes[index]!, b = bytes[index + 1], c = bytes[index + 2];
      output += base64[a >>> 2]! + base64[((a & 3) << 4) | ((b ?? 0) >>> 4)]!
        + (b === undefined ? "=" : base64[((b & 15) << 2) | ((c ?? 0) >>> 6)]!)
        + (c === undefined ? "=" : base64[c & 63]!);
    }
    return output;
  }
  return value;
}
class NativeResultSet implements ResultSet {
  constructor(public columns: string[], public columnTypes: string[], public rows: Row[],
    public rowsAffected: number, public lastInsertRowid: bigint | undefined) {}
  toJSON() {
    return { columns: this.columns, columnTypes: this.columnTypes,
      rows: this.rows.map(row => Array.prototype.map.call(row, jsonValue)), rowsAffected: this.rowsAffected,
      lastInsertRowid: this.lastInsertRowid === undefined ? null : this.lastInsertRowid.toString() };
  }
}

/** Reconstruct pinned libsql Row descriptors: positional values and length are
 * nonenumerable; first named column wins. defineProperty safely preserves own
 * __proto__/constructor columns and the original numeric-name collision rules.
 */
export function decodeNativeSqliteResult(input: unknown, intMode: IntMode = "number"): ResultSet {
  mode(intMode);
  const result = record(input, ["columns", "columnTypes", "rows", "rowsAffected", "lastInsertRowid"]);
  if (!Array.isArray(result.columns) || !Array.isArray(result.columnTypes) || !Array.isArray(result.rows)
    || result.columnTypes.length !== result.columns.length || !Number.isSafeInteger(result.rowsAffected)
    || (result.rowsAffected as number) < 0) return fail();
  const columns = Array.from(result.columns, value => { if (typeof value !== "string") return fail(); return value; });
  const columnTypes = Array.from(result.columnTypes, value => { if (typeof value !== "string") return fail(); return value; });
  const lastInsertRowid = result.lastInsertRowid === null ? undefined : integer(result.lastInsertRowid);
  const rows = Array.from(result.rows, values => {
    if (!Array.isArray(values) || values.length !== columns.length) return fail();
    const row = {} as Row;
    Object.defineProperty(row, "length", { value: values.length });
    for (let index = 0; index < values.length; index++) {
      const value = decodeNativeSqliteValue(values[index], intMode);
      Object.defineProperty(row, index, { value });
      if (!Object.hasOwn(row, columns[index]!)) Object.defineProperty(row, columns[index]!, {
        value, enumerable: true, configurable: true, writable: true,
      });
    }
    return row;
  });
  return new NativeResultSet(columns, columnTypes, rows, result.rowsAffected as number, lastInsertRowid);
}
