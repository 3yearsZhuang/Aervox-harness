import { afterEach, describe, expect, it, vi } from "vitest";
import { createReviewItem, getLocalDayBounds, updateAfterAnswer } from "../src/answer.js";
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
    expect(review.schedulerVersion).toBe(2);
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

  it("按 IANA 时区增加本地自然日，跨入夏令时仍保留墙上时间", () => {
    const review = createReviewItem(makeItem(), false, {
      now: new Date("2026-03-07T17:00:00.000Z"),
      timeZone: "America/New_York",
    });
    expect(review.dueAt.toISOString()).toBe("2026-03-08T16:00:00.000Z");
  });

  it("跨夏令时开始日仍保留墙上时间（多日间隔）", () => {
    const review = createReviewItem(makeItem({ correctStreak: 2 }), true, {
      now: new Date("2026-03-05T17:00:00.000Z"),
      timeZone: "America/New_York",
    });
    expect(review.intervalDays).toBe(4);
    expect(review.dueAt.toISOString()).toBe("2026-03-09T16:00:00.000Z");
  });

  it("跨夏令时结束日仍保留墙上时间", () => {
    const review = createReviewItem(makeItem(), false, {
      now: new Date("2026-10-31T16:00:00.000Z"),
      timeZone: "America/New_York",
    });
    expect(review.dueAt.toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });

  it("同一时刻在不同时区调度产生不同的到期时间", () => {
    const now = new Date("2026-03-07T12:00:00.000Z");
    const shanghai = createReviewItem(makeItem(), false, { now, timeZone: "Asia/Shanghai" });
    const newYork = createReviewItem(makeItem(), false, { now, timeZone: "America/New_York" });
    expect(shanghai.dueAt.toISOString()).toBe("2026-03-08T12:00:00.000Z");
    expect(newYork.dueAt.toISOString()).toBe("2026-03-08T11:00:00.000Z");
    expect(shanghai.dueAt.getTime()).not.toBe(newYork.dueAt.getTime());
  });

  it("南半球夏令时跨入仍保留墙上时间", () => {
    const review = createReviewItem(makeItem(), false, {
      now: new Date("2026-10-03T14:00:00.000Z"),
      timeZone: "Australia/Sydney",
    });
    expect(review.dueAt.toISOString()).toBe("2026-10-04T13:00:00.000Z");
  });

  it("拒绝非法 IANA 时区", () => {
    expect(() => createReviewItem(makeItem(), false, { timeZone: "Mars/Olympus" })).toThrow(RangeError);
  });
});

describe("getLocalDayBounds", () => {
  it("夏令时开始日返回 23 小时的本地自然日", () => {
    const bounds = getLocalDayBounds(new Date("2026-03-08T16:00:00.000Z"), "America/New_York");
    expect(bounds.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });

  it("夏令时结束日返回 25 小时的本地自然日", () => {
    const bounds = getLocalDayBounds(new Date("2026-11-01T12:00:00.000Z"), "America/New_York");
    expect(bounds.start.toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-11-02T05:00:00.000Z");
    const durationHours = (bounds.end.getTime() - bounds.start.getTime()) / 3_600_000;
    expect(durationHours).toBe(25);
  });

  it("南半球夏令时开始日返回 23 小时的本地自然日", () => {
    const bounds = getLocalDayBounds(new Date("2026-10-03T14:00:00.000Z"), "Australia/Sydney");
    expect(bounds.start.toISOString()).toBe("2026-10-03T14:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-10-04T13:00:00.000Z");
    const durationHours = (bounds.end.getTime() - bounds.start.getTime()) / 3_600_000;
    expect(durationHours).toBe(23);
  });

  it("无 DST 时区始终返回 24 小时自然日", () => {
    const bounds = getLocalDayBounds(new Date("2026-06-15T08:00:00.000Z"), "Asia/Shanghai");
    expect(bounds.start.toISOString()).toBe("2026-06-14T16:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-06-15T16:00:00.000Z");
    const durationHours = (bounds.end.getTime() - bounds.start.getTime()) / 3_600_000;
    expect(durationHours).toBe(24);
  });

  it("UTC 时区日界线与 ISO 日期对齐", () => {
    const bounds = getLocalDayBounds(new Date("2026-07-10T15:30:00.000Z"), "UTC");
    expect(bounds.start.toISOString()).toBe("2026-07-10T00:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-07-11T00:00:00.000Z");
  });
});
