import { describe, expect, it } from "vitest";
import { normalizeMistakeNote } from "../src/mistake-insight.js";

describe("normalizeMistakeNote", () => {
  it("保留有意义的说明，并清除只含空白的说明", () => {
    expect(normalizeMistakeNote("  忘记处理边界条件  ")).toBe("忘记处理边界条件");
    expect(normalizeMistakeNote(" \n ")).toBeNull();
  });

  it("未提供说明时不改变既有说明", () => {
    expect(normalizeMistakeNote(undefined)).toBeUndefined();
  });
});
