import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKER_INTERVALS,
  resolveWorkerTaskInterval,
} from "../src/task-scheduling.js";

describe("worker task scheduling", () => {
  it("uses documented per-task defaults when the global tick is unchanged", () => {
    expect(resolveWorkerTaskInterval("proactive-intelligence", 5_000, {}))
      .toBe(DEFAULT_WORKER_INTERVALS["proactive-intelligence"]);
    expect(resolveWorkerTaskInterval("outbox", 5_000, {})).toBe(3_000);
  });

  it("keeps an explicit global tick as a global override", () => {
    expect(resolveWorkerTaskInterval("proactive-intelligence", 1_000, {})).toBe(1_000);
  });

  it("accepts both documented underscore and internal hyphen task keys", () => {
    expect(resolveWorkerTaskInterval("attempt-recovery", 5_000, {attempt_recovery: 12_000})).toBe(12_000);
    expect(resolveWorkerTaskInterval("inbox-expiry", 5_000, {"inbox-expiry": 8_000})).toBe(8_000);
  });
});
