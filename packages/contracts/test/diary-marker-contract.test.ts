import { describe, expect, it } from "vitest";
import { DIARY_TEMPLATE_MARKER, detectDiaryGeneratedBy } from "../src/diary-marker.js";

describe("diary template marker (single implementation)", () => {
  it("detects template-generated diaries from the marker", () => {
    const content = `2026-11-26 的日记\n\n${DIARY_TEMPLATE_MARKER}，配置 LLM 后将由思思亲手书写。）`;
    expect(detectDiaryGeneratedBy(content)).toBe("template");
  });

  it("treats content without the marker as LLM-generated", () => {
    expect(detectDiaryGeneratedBy("今天整理了三个错题。")).toBe("llm");
    expect(detectDiaryGeneratedBy("")).toBe("llm");
  });
});
