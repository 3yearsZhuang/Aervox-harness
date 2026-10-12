import { describe, expect, it } from "vitest";
import { TopK } from "../src/search/top-k.js";

describe("stable bounded top-K", () => {
  it("agrees with stable full sorting over varied inputs and limits", () => {
    let seed = 42;
    for (const count of [0, 1, 10, 1000]) {
      const values = Array.from({ length: count }, (_, id) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return { id, score: (seed % 21) - 10 };
      });
      for (const limit of [0, 1, 3, 10, 1001]) {
        for (const threshold of [-10, 0, 5]) {
          const top = new TopK<(typeof values)[number]>(limit);
          for (const value of values) if (value.score >= threshold) top.add(value, value.score);
          const expected = values.filter((x) => x.score >= threshold).sort((a, b) => b.score - a.score).slice(0, limit);
          expect(top.values()).toEqual(expected);
          expect(top.values()).toEqual(expected);
        }
      }
    }
  });

  it("keeps earlier equal scores and can continue after reading results", () => {
    const top = new TopK<string>(2);
    top.add("first", 1);
    top.add("second", 1);
    top.add("third", 1);
    expect(top.values()).toEqual(["first", "second"]);
    top.add("higher", 2);
    top.add("invalid", NaN);
    expect(top.values()).toEqual(["higher", "first"]);
  });

  it("rejects invalid capacities", () => {
    for (const limit of [-1, 1.5, Infinity, NaN]) expect(() => new TopK(limit)).toThrow();
  });
});
