import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewItem, updateAfterAnswer } from "../src/answer.js";
import type { KnowledgeItem } from "../src/types.js";

afterEach(() => {
  vi.useRealTimers();
});

function makeItem(overrides: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id: "k_tn_001",
    name: "三角函数",
    correctCount: 0,
    wrongCount: 0,
    correctStreak: 0,
    mastery: 0,
    ...overrides,
  };
}

function setNow(iso: string): void {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe("updateAfterAnswer", () => {
  it("答对时递增正确计数与连对，mastery +0.1", () => {
    const item = makeItem();
    updateAfterAnswer(item, true);
    expect(item.correctCount).toBe(1);
    expect(item.correctStreak).toBe(1);
    expect(item.mastery).toBeCloseTo(0.1);
  });

  it("答错时递增错误计数并清零连对，mastery -0.1", () => {
    const item = makeItem({ correctCount: 3, correctStreak: 3, mastery: 0.5 });
    updateAfterAnswer(item, false);
    expect(item.wrongCount).toBe(1);
    expect(item.correctStreak).toBe(0);
    expect(item.mastery).toBeCloseTo(0.4);
  });

  it("mastery 封顶为 1", () => {
    const item = makeItem({ mastery: 0.95 });
    updateAfterAnswer(item, true);
    expect(item.mastery).toBe(1);
  });

  it("mastery 触底为 0", () => {
    const item = makeItem({ mastery: 0.05 });
    updateAfterAnswer(item, false);
    expect(item.mastery).toBe(0);
  });
});

describe("createReviewItem", () => {
  it("错误答案：1 天后复习", () => {
    setNow("2026-01-01T00:00:00Z");
    const review = createReviewItem(makeItem(), false);
    expect(review.schedulerVersion).toBe(1);
    expect(review.knowledgeId).toBe("k_tn_001");
    expect(review.intervalDays).toBe(1);
    expect(review.dueAt.toISOString()).toBe("2026-01-02T00:00:00.000Z");
  });

  it("答对且连对 1：2 天后复习", () => {
    setNow("2026-01-01T00:00:00Z");
    const review = createReviewItem(makeItem({ correctStreak: 1 }), true);
    expect(review.intervalDays).toBe(2);
    expect(review.dueAt.toISOString()).toBe("2026-01-03T00:00:00.000Z");
  });

  it("答对且连对 2：4 天后复习", () => {
    setNow("2026-01-01T00:00:00Z");
    const review = createReviewItem(makeItem({ correctStreak: 2 }), true);
    expect(review.intervalDays).toBe(4);
    expect(review.dueAt.toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });

  it("答对且连对 3：8 天后复习", () => {
    setNow("2026-01-01T00:00:00Z");
    const review = createReviewItem(makeItem({ correctStreak: 3 }), true);
    expect(review.intervalDays).toBe(8);
    expect(review.dueAt.toISOString()).toBe("2026-01-09T00:00:00.000Z");
  });

  it("答对且连对 4+：15 天后复习", () => {
    setNow("2026-01-01T00:00:00Z");
    const review = createReviewItem(makeItem({ correctStreak: 4 }), true);
    expect(review.intervalDays).toBe(15);
    expect(review.dueAt.toISOString()).toBe("2026-01-16T00:00:00.000Z");
  });

  it("答对但连对 0（未先 update）：1 天兜底", () => {
    setNow("2026-01-01T00:00:00Z");
    const review = createReviewItem(makeItem({ correctStreak: 0 }), true);
    expect(review.intervalDays).toBe(1);
  });
});
