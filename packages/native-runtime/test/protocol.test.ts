import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeNativeResponse, matchesNativePayload } from "../src/protocol.js";

const fixtures = JSON.parse(readFileSync(new URL("../../../native/protocol/fixtures.json", import.meta.url), "utf8")) as {
  name: string; method: string; side: "params" | "result"; value: unknown; valid: boolean;
}[];

describe("shared Rust/TypeScript IPC contract", () => {
  for (const fixture of fixtures) {
    it(fixture.name, () => {
      expect(matchesNativePayload(fixture.method, fixture.side, fixture.value)).toBe(fixture.valid);
    });
  }
  it("rejects mismatched IDs, malformed errors and ambiguous response envelopes", () => {
    for (const value of [null, [], { id: 2, error: "failed" }, { id: 1, error: false }, { id: 1, error: "" }, { id: 1, result: {}, error: "failed" }]) {
      expect(() => decodeNativeResponse("hello", 1, value)).toThrow("native_response_invalid");
    }
    expect(decodeNativeResponse("hello", 1, { id: 1, error: "native_method_unknown" })).toEqual({ error: "native_method_unknown" });
  });
  it("rejects nonfinite scores and oversized candidate arrays before handing results to consumers", () => {
    for (const score of [Infinity, -Infinity, NaN]) {
      expect(matchesNativePayload("vector.search", "result", { hits: [{ id: "a", score }], cacheHit: true })).toBe(false);
    }
    expect(matchesNativePayload("vector.search", "result", { hits: Array.from({ length: 201 }, () => ({ id: "a", score: 0 })), cacheHit: true })).toBe(false);
  });
});
