import { afterEach, describe, expect, it } from "vitest";
import { createClient, type Client, type InStatement, type InValue, type IntMode, type ResultSet } from "@libsql/client";
import { sql } from "drizzle-orm";
import { sqliteTable, text, blob, integer } from "drizzle-orm/sqlite-core";
import { build } from "esbuild";
import { createContext, runInContext } from "node:vm";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInjectedDatabase } from "../src/database.js";
import { decodeNativeSqliteResult, decodeNativeSqliteValue, encodeNativeSqliteValue, type NativeSqliteResult } from "../src/driver/native-sqlite-values.js";

const directories: string[] = [], clients: Client[] = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function client(intMode: IntMode = "number") {
  const path = mkdtempSync(join(tmpdir(), "aervox-native-values-")); directories.push(path);
  const result = createClient({ url: `file:${join(path, "test.db")}`, intMode }); clients.push(result); return result;
}
const empty = (): NativeSqliteResult => ({ columns: [], columnTypes: [], rows: [], rowsAffected: 0, lastInsertRowid: null });
function wire(result: ResultSet): NativeSqliteResult {
  return { columns: result.columns, columnTypes: result.columnTypes, rows: result.rows.map(row => Array.from(row, value =>
    // SQLite REAL results can overflow even though libsql rejects nonfinite binds.
    typeof value === "number" && !Number.isFinite(value)
      ? { type: "float" as const, value: value === Infinity ? "Infinity" as const : "-Infinity" as const }
      : encodeNativeSqliteValue(value))),
    rowsAffected: result.rowsAffected, lastInsertRowid: result.lastInsertRowid?.toString() ?? null };
}
function binding(value: InValue, intMode: IntMode): InValue {
  // The native INTEGER tag binds as int64 independent of result presentation.
  return decodeNativeSqliteValue(JSON.parse(JSON.stringify(encodeNativeSqliteValue(value, intMode))), "bigint");
}
function statement(input: InStatement, intMode: IntMode): InStatement {
  if (typeof input === "string") return input;
  const args = input.args;
  if (Array.isArray(args)) return { sql: input.sql, args: args.map(value => binding(value, intMode)) };
  const mapped: Record<string, InValue> = {};
  for (const key of Object.keys(args)) Object.defineProperty(mapped, key, { value: binding(args[key]!, intMode), enumerable: true });
  return { sql: input.sql, args: mapped };
}

describe("candidate native SQLite JSON values", () => {
  it("preserves text/NUL, signed int64 and exact binary slices without string coercion", () => {
    for (const value of [null, "中文\0尾\ud800", 1, 1.5, -0, 0n, -9223372036854775808n, 9223372036854775807n]) {
      const encoded = encodeNativeSqliteValue(value);
      expect(decodeNativeSqliteValue(JSON.parse(JSON.stringify(encoded)), "bigint")).toBe(value);
    }
    const bytes = Uint8Array.from({ length: 256 }, (_, index) => index);
    const source = bytes.subarray(7, 247), encoded = encodeNativeSqliteValue(source);
    expect(new Uint8Array(decodeNativeSqliteValue(encoded) as ArrayBuffer)).toEqual(source);
    expect(encodeNativeSqliteValue(new ArrayBuffer(0))).toEqual({ type: "blob", value: "" });
    expect(decodeNativeSqliteValue({ type: "int64", value: "-3" }, "string")).toBe("-3");
    expect(() => decodeNativeSqliteValue({ type: "int64", value: "9007199254740992" })).toThrow(RangeError);
  });

  it("rejects malformed values, nonfinite input, unsupported objects and noncanonical int64/binary", () => {
    for (const value of [undefined, NaN, Infinity, -Infinity, {}, [], new Date(NaN), new Int32Array([1]), 9223372036854775808n]) {
      expect(() => encodeNativeSqliteValue(value as InValue)).toThrow();
    }
    for (const value of [null, {}, { type: "unknown", value: "x" }, { type: "null", value: null }, { type: "text", value: 1 },
      { type: "float", value: "0" }, { type: "float", value: "-0.0" }, { type: "float", value: "+Infinity" },
      { type: "float", value: NaN }, { type: "float", value: Infinity }, { type: "int64", value: "+1" },
      { type: "int64", value: "1\n" }, { type: "int64", value: "1\r\n" }, { type: "int64", value: "1\u2028" },
      { type: "int64", value: "01" }, { type: "int64", value: "-0" }, { type: "int64", value: "9223372036854775808" },
      { type: "int64", value: "-9223372036854775809" }, { type: "blob", value: "0" }, { type: "blob", value: "FF" },
      { type: "blob", value: "0\n" }, { type: "blob", value: "0\u2029" }, { type: "blob", value: "zz" }, { type: "text", value: "x", extra: true }]) expect(() => decodeNativeSqliteValue(value)).toThrow();
    expect(() => encodeNativeSqliteValue(1, "unknown" as IntMode)).toThrow();
  });

  it.each(["number", "bigint", "string"] as const)("matches pinned SQLite input binding types and outputs in %s mode", async intMode => {
    const direct = client(intMode), backend = client("bigint");
    for (const value of [-0, Number.MIN_VALUE, Number.MAX_VALUE, 1, 1.5, 1n, true, false, new Date(123), null, "中文\0尾", Uint8Array.of(0, 1, 255)]) {
      const query = { sql: "SELECT typeof(?) AS kind, CASE WHEN typeof(?)='blob' THEN NULL ELSE json_quote(?) END AS quoted, ? AS value", args: [value, value, value, value] };
      const expected = await direct.execute(query);
      const throughWire = decodeNativeSqliteResult(JSON.parse(JSON.stringify(wire(await backend.execute(statement(query, intMode))))), intMode);
      expect(throughWire.toJSON()).toEqual(expected.toJSON());
      expect(throughWire.rows[0]?.kind).toBe(typeof value === "bigint" || (typeof value === "boolean" && intMode === "bigint") ? "integer"
        : typeof value === "boolean" && intMode === "string" ? "text" : value instanceof Uint8Array ? "blob"
          : value === null ? "null" : typeof value === "string" ? "text" : "real");
      if (typeof value === "string") expect(JSON.parse(throughWire.rows[0]!.quoted as string)).toBe(value);
    }
  });

  it("preserves overflowing SQLite REAL results separately from finite-only input binds", async () => {
    const source = client("bigint");
    const expected = await source.execute("SELECT 1e999 AS positive, -1e999 AS negative, 1e308 * 1e308 AS product, 0.0/0.0 AS missing");
    const actual = decodeNativeSqliteResult(JSON.parse(JSON.stringify(wire(expected))));
    expect(actual.rows[0]?.positive).toBe(Infinity);
    expect(actual.rows[0]?.negative).toBe(-Infinity);
    expect(actual.rows[0]?.product).toBe(Infinity);
    expect(actual.rows[0]?.missing).toBeNull();
    expect(actual.toJSON()).toEqual(expected.toJSON());
    for (const value of [Infinity, -Infinity, NaN]) expect(() => encodeNativeSqliteValue(value)).toThrow();
  });

  it("matches pinned duplicate, reserved and numeric column descriptors without changing prototypes", async () => {
    const source = client("bigint");
    for (const query of ['SELECT 1 AS "__proto__", 2 AS "constructor", 3 AS "__proto__"',
      'SELECT 1 AS "1", 2 AS "x", 3 AS "length"', 'SELECT 1 AS "a", 2 AS "a", 3 AS "0"']) {
      const expected = await source.execute(query), actual = decodeNativeSqliteResult(wire(expected), "bigint");
      expect(Object.getPrototypeOf(actual.rows[0])).toBe(Object.prototype);
      expect(Object.getOwnPropertyDescriptors(actual.rows[0])).toEqual(Object.getOwnPropertyDescriptors(expected.rows[0]));
      expect(actual.toJSON()).toEqual(expected.toJSON());
      expect(Object.keys(actual)).not.toContain("toJSON");
      expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(actual), "toJSON")?.enumerable).toBe(false);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("validates complete result shape and never invents an absent insert rowid", async () => {
    expect(decodeNativeSqliteResult(empty()).lastInsertRowid).toBeUndefined();
    for (const value of [{ ...empty(), columns: ["x"] }, { ...empty(), columnTypes: [null] }, { ...empty(), rows: [[{ type: "null" }]] },
      { ...empty(), rowsAffected: -1 }, { ...empty(), rowsAffected: 1.1 }, { ...empty(), rowsAffected: Number.MAX_SAFE_INTEGER + 1 },
      { ...empty(), lastInsertRowid: "1\n" }, { ...empty(), lastInsertRowid: "01" }, { ...empty(), lastInsertRowid: "9223372036854775808" },
      { ...empty(), lastInsertRowid: undefined }, { ...empty(), columns: [undefined], columnTypes: [""] }, { ...empty(), extra: true }]) {
      expect(() => decodeNativeSqliteResult(value)).toThrow();
    }
    const source = client("bigint"); await source.execute("CREATE TABLE inserted(id INTEGER PRIMARY KEY)");
    const result = await source.execute("INSERT INTO inserted DEFAULT VALUES"), actual = decodeNativeSqliteResult(wire(result));
    expect(actual.lastInsertRowid).toBe(result.lastInsertRowid);
    expect(actual.rowsAffected).toBe(1); expect(actual.toJSON()).toEqual(result.toJSON());
    const selected = await source.execute("SELECT id FROM inserted");
    expect(decodeNativeSqliteResult(wire(selected)).lastInsertRowid).toBeUndefined();
  });

  it("serializes binary values like the pinned ResultSet without Node encoders", () => {
    for (let size = 0; size <= 256; size++) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => index);
      const result = decodeNativeSqliteResult({ columns: ["data"], columnTypes: ["BLOB"], rows: [[encodeNativeSqliteValue(bytes)]], rowsAffected: 0, lastInsertRowid: null });
      expect(result.toJSON().rows).toEqual([[Buffer.from(bytes).toString("base64")]]);
    }
  });

  it("feeds real file SQLite results through JSON mapping into injected Drizzle reads", async () => {
    const backend = client("bigint");
    await backend.execute("CREATE TABLE native_values(id TEXT PRIMARY KEY, active INTEGER NOT NULL, data BLOB)");
    await backend.execute({ sql: "INSERT INTO native_values VALUES (?, ?, ?)", args: ["row", 1n, Uint8Array.of(0, 128, 255)] });
    const proxy: Client = new Proxy(backend, { get(target, property) {
      if (property === "execute") return async (input: InStatement) => decodeNativeSqliteResult(JSON.parse(JSON.stringify(wire(await target.execute(statement(input, "number"))))));
      const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
    } });
    const db = createInjectedDatabase(proxy);
    const table = sqliteTable("native_values", { id: text("id").primaryKey(), active: integer("active", { mode: "boolean" }).notNull(), data: blob("data", { mode: "buffer" }) });
    const selected = await db.select({ id: table.id, active: table.active, body: table.data }).from(table);
    expect(selected).toHaveLength(1); expect(selected[0]?.id).toBe("row"); expect(selected[0]?.active).toBe(true);
    expect(new Uint8Array(selected[0]!.body!)).toEqual(Uint8Array.of(0, 128, 255));
    const row = await db.get(sql`SELECT json_quote(${"中文\0尾"}) AS escaped, 1.5 AS fraction FROM native_values`);
    expect(JSON.parse((row as { escaped: string }).escaped)).toBe("中文\0尾");
    expect(row).toMatchObject({ fraction: 1.5 });
  });

  it("runs its entire module without Buffer/process/require and keeps Web declaration types", async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { exports: Record<string, { default: string; types: string }> };
    const exported = manifest.exports["./native-sqlite-values"]!;
    const entry = resolve(root, exported.default);
    const built = await build({ entryPoints: [entry], bundle: true, platform: "browser", treeShaking: false,
      format: "iife", globalName: "NativeValues", write: false, metafile: true, logLevel: "silent" });
    expect(Object.values(built.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
    expect(Object.keys(built.metafile!.inputs)).toHaveLength(1);
    const context = createContext({}); runInContext(built.outputFiles![0]!.text, context);
    expect(runInContext("typeof Buffer + ':' + typeof process + ':' + typeof require", context)).toBe("undefined:undefined:undefined");
    expect(runInContext(`(() => {
      const blob = NativeValues.encodeNativeSqliteValue(new Uint8Array([0, 255]));
      const result = NativeValues.decodeNativeSqliteResult({ columns: ['__proto__', 'body'], columnTypes: ['', 'BLOB'],
        rows: [[{type:'text',value:'中文\\0尾'}, blob]], rowsAffected:0,lastInsertRowid:null });
      return JSON.stringify(result);
    })()`, context)).toBe(JSON.stringify({ columns: ["__proto__", "body"], columnTypes: ["", "BLOB"], rows: [["中文\0尾", "AP8="]], rowsAffected: 0, lastInsertRowid: null }));
    const path = mkdtempSync(join(tmpdir(), "aervox-native-values-types-")); directories.push(path);
    const config = join(path, "tsconfig.json");
    writeFileSync(config, JSON.stringify({ compilerOptions: { target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext",
      strict: true, skipLibCheck: false, noEmit: true, types: [], lib: ["ES2023", "DOM"] }, files: [resolve(root, exported.types)] }));
    execFileSync(process.execPath, [fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)), "-p", config], { stdio: "pipe" });
    const files = execFileSync(process.execPath, [fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)), "-p", config, "--listFilesOnly"], { encoding: "utf8" });
    expect(files).not.toMatch(/@types\/node\//);
  });
});
