import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { decodeCanonicalUtf8Base64Url, encodeUtf8Base64Url, utf8ByteLength } from "../src/encoding/utf8-base64url.js";

const codecSource = fileURLToPath(new URL("../src/encoding/utf8-base64url.ts", import.meta.url));
const historySource = fileURLToPath(new URL("../src/repositories/sqlite/conversation/history-page.ts", import.meta.url));
function oldDecode(token: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(token)) throw new Error("Invalid token");
  const text = Buffer.from(token, "base64url").toString("utf8");
  if (Buffer.from(text).toString("base64url") !== token) throw new Error("Invalid token");
  return text;
}
const result = (decode: (token: string) => string, token: string) => {
  try { return { ok: true, text: decode(token) }; }
  catch { return { ok: false }; }
};
function seeded(seed: number) {
  return () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
}

describe("Web-standard UTF-8 and canonical base64url", () => {
  it("preserves Buffer's UTF-16 replacement and UTF-8 byte semantics across deterministic string inputs", () => {
    const random = seeded(0x4176_6f78);
    const strings = ["", "\0", "中文/会话\0尾", "😀👩‍💻", "\ufeff", "\ufeff\ufeffa", "\ufffd",
      "\ud800", "\udfff", "\ud800\ud800", "\udfff\ud800", "a\ud800b\udfff", "\ud800\udc00", "\udbff\udfff"];
    for (let index = 0; index < 2048; index++) {
      const units = Array.from({ length: random() % 96 }, () => random() & 0xffff);
      strings.push(String.fromCharCode(...units));
    }
    for (const text of strings) {
      const encoded = Buffer.from(text, "utf8");
      expect(utf8ByteLength(text)).toBe(encoded.length);
      expect(encodeUtf8Base64Url(text)).toBe(encoded.toString("base64url"));
      expect(decodeCanonicalUtf8Base64Url(encoded.toString("base64url"))).toBe(encoded.toString("utf8"));
    }
  });

  it("matches the old roundtrip acceptance for all one/two-byte payloads and seeded longer arbitrary bytes", () => {
    const check = (bytes: Uint8Array) => {
      const token = Buffer.from(bytes).toString("base64url");
      expect(result(decodeCanonicalUtf8Base64Url, token), token).toEqual(result(oldDecode, token));
    };
    for (let first = 0; first < 256; first++) {
      check(Uint8Array.of(first));
      for (let second = 0; second < 256; second++) check(Uint8Array.of(first, second));
    }
    const random = seeded(0x5546_5438);
    for (let index = 0; index < 2048; index++) {
      check(Uint8Array.from({ length: random() % 256 }, () => random() & 255));
    }
  });

  it("rejects invalid UTF-8, padding, alternate alphabet and noncanonical tail bits without normalization", () => {
    const invalidBytes = [[0xc0, 0x80], [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xf0, 0x80, 0x80, 0x80],
      [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80], [0xe2, 0x82], [0x80], [0xff], [0xfe]];
    for (const bytes of invalidBytes) expect(() => decodeCanonicalUtf8Base64Url(Buffer.from(bytes).toString("base64url"))).toThrow();
    for (const token of ["YQ=", "YQ==", "YQ\n", " YQ", "Y+", "Y/", "YQ\0", "中", "A", "AAAAA", "YR", "YWJ"]) {
      expect(() => decodeCanonicalUtf8Base64Url(token), JSON.stringify(token)).toThrow();
      expect(result(decodeCanonicalUtf8Base64Url, token)).toEqual(result(oldDecode, token));
    }
    expect(decodeCanonicalUtf8Base64Url("77u_77-9")).toBe("\ufeff\ufffd");
  });

  it("bundles codec and real history read entry without Node globals or a Node driver", async () => {
    for (const [entry, globalName] of [[codecSource, "WebEncoding"], [historySource, "WebHistory"]]) {
      const bundled = await build({ entryPoints: [entry!], bundle: true, platform: "browser", treeShaking: false,
        format: "iife", globalName, write: false, metafile: true, logLevel: "silent" });
      expect(Object.values(bundled.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
      expect(Object.keys(bundled.metafile!.inputs).filter(path => /(?:\/client\.ts|node:|\/packages\/native-runtime\/|\/node_modules\/(?:@libsql|libsql|@aervox\/native-runtime)\/)/.test(path))).toEqual([]);
      const context = createContext({ TextEncoder, TextDecoder });
      runInContext(bundled.outputFiles![0]!.text, context);
      expect(runInContext("typeof Buffer + ':' + typeof process + ':' + typeof require", context)).toBe("undefined:undefined:undefined");
      if (entry === codecSource) {
        expect(runInContext(`WebEncoding.decodeCanonicalUtf8Base64Url(WebEncoding.encodeUtf8Base64Url('中文\\0尾'))`, context)).toBe("中文\0尾");
        expect(runInContext(`WebEncoding.utf8ByteLength('中😀\\ud800')`, context)).toBe(Buffer.byteLength("中😀\ud800"));
      } else {
        expect(runInContext("typeof WebHistory.readSessionHistoryPage", context)).toBe("function");
        context.cursor = Buffer.from(JSON.stringify({ v: 1, sessionId: "中文\0会话", beforeTurnId: "轮\0尾" })).toString("base64url");
        const observed = await runInContext(`(async () => {
          const db = { transaction: async run => run({ select: () => ({ from: () => ({ where: async () => [] }) }) }) };
          const read = async token => {
            try { await WebHistory.readSessionHistoryPage(db, { sessionId: '中文\\0会话', cursor: token }); }
            catch (error) { return error.code; }
          };
          return [await read(cursor), await read('_w')];
        })()`, context);
        // A real read validates the valid Unicode/NUL cursor and reaches the
        // injected database; invalid UTF-8 is rejected before any query.
        expect([...observed]).toEqual(["SESSION_NOT_FOUND", "INVALID_HISTORY_QUERY"]);
      }
    }
  });

  it("typechecks the codec against DOM declarations with no ambient Node types", () => {
    const dir = mkdtempSync(join(tmpdir(), "aervox-web-encoding-types-"));
    try {
      const config = join(dir, "tsconfig.json");
      writeFileSync(config, JSON.stringify({ compilerOptions: {
        target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
        noUncheckedIndexedAccess: true, noEmit: true, types: [], lib: ["ES2023", "DOM"],
      }, files: [codecSource] }));
      execFileSync(process.execPath, [fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)), "-p", config], { stdio: "pipe" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
