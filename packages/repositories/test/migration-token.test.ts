/**
 * Aervox｜思隅 @aervox/repositories — T-10 Token 分账测试
 */
import { describe, expect, it } from "vitest";
import { splitTokenUsage } from "../src/token-usage.js";

describe("T-10 Token 用量分账", () => {
  it("旧形态 { prompt, completion, total } 归并为非缓存", () => {
    const r = splitTokenUsage({ prompt: 100, completion: 20, total: 120 });
    expect(r.noncacheReadTokens).toBe(100);
    expect(r.cacheReadTokens).toBe(0);
    expect(r.cacheWriteTokens).toBe(0);
    expect(r.completionTokens).toBe(20);
    expect(r.totalTokens).toBe(120);
  });

  it("OpenAI 形态带缓存命中扣减非缓存", () => {
    const raw = {
      prompt_tokens: 500,
      completion_tokens: 30,
      total_tokens: 530,
      prompt_tokens_details: { cached_tokens: 200 },
    };
    const r = splitTokenUsage(raw);
    expect(r.cacheReadTokens).toBe(200);
    expect(r.noncacheReadTokens).toBe(300);
    expect(r.completionTokens).toBe(30);
    expect(r.totalTokens).toBe(530);
  });

  it("缓存读 + 缓存写均可识别", () => {
    const raw = {
      promptTokens: 400,
      completionTokens: 10,
      totalTokens: 410,
      cacheReadTokens: 150,
      cacheWriteTokens: 50,
    };
    const r = splitTokenUsage(raw);
    expect(r.cacheReadTokens).toBe(150);
    expect(r.cacheWriteTokens).toBe(50);
    expect(r.noncacheReadTokens).toBe(200);
    expect(r.totalTokens).toBe(410);
  });

  it("非法输入归零", () => {
    const r = splitTokenUsage(null);
    expect(r.totalTokens).toBe(0);
    expect(r.noncacheReadTokens).toBe(0);
  });
});
