/**
 * Aervox｜思隅 @aervox/agent-loop — 恢复裁决矩阵测试（AVX-HAR-001 §11.3 首范式）
 *
 * decideResume 纯函数裁决矩阵：
 * 可续（resumable）⇔ 最后一工具结果批次全部 executed 且无终态事件；
 * terminal / mixed_batch / no_committed_tool / outcome_unknown 一律收敛。
 */
import { describe, expect, it } from "vitest";
import { decideResume } from "../src/index.js";
import type { ResumeEventLike, ResumeExecutionLike } from "../src/index.js";

/** Host executionId 形状：attempt:step:seq */
const ev = (eventType: string, sequence: number, executionId?: string): ResumeEventLike => ({
  eventType,
  sequence,
  data: executionId ? { executionId } : undefined,
});

const exec = (invocationId: string, status: string): ResumeExecutionLike => ({ invocationId, status });

/** 一个完整可续场景：工具结果批次已收口，尚未注入
    step2 工具批次（全部 executed）：atp:2:1、atp:2:2 → 之后无事件 */
const resumableEvents: ResumeEventLike[] = [
  ev("message", 1),
  ev("delta", 2),
  ev("tool_request", 3, "atp:2:1"),
  ev("tool_result", 4, "atp:2:1"),
  ev("tool_request", 5, "atp:2:2"),
  ev("tool_result", 6, "atp:2:2"),
];

describe("decideResume 恢复裁决矩阵", () => {
  it("resumable：最后工具批次全部 executed → 可续，返回 lastSequence", () => {
    const decision = decideResume(resumableEvents, [exec("atp:2:1", "executed"), exec("atp:2:2", "executed")]);
    expect(decision).toEqual({ resume: true, reason: "resumable", lastSequence: 6 });
  });

  it("terminal_event：已存在 done 终态 → 不得续跑", () => {
    const events = [...resumableEvents, ev("done", 7)];
    const decision = decideResume(events, [exec("atp:2:1", "executed"), exec("atp:2:2", "executed")]);
    expect(decision.resume).toBe(false);
    expect(decision.reason).toBe("terminal_event");
  });

  it("mixed_batch：同批部分 executed 部分 rejected → 收敛（严格批次语义）", () => {
    const decision = decideResume(resumableEvents, [exec("atp:2:1", "executed"), exec("atp:2:2", "rejected")]);
    expect(decision).toEqual({ resume: false, reason: "mixed_batch" });
  });

  it("outcome_unknown：账本缺失/待决/未知 → 不自动重放", () => {
    for (const status of ["pending", "outcome_unknown", "pending_approval"]) {
      const decision = decideResume(resumableEvents, [exec("atp:2:1", "executed"), exec("atp:2:2", status)]);
      expect(decision.resume).toBe(false);
      expect(decision.reason).toBe("outcome_unknown");
    }
    // 账本完全缺失
    const missing = decideResume(resumableEvents, []);
    expect(missing.reason).toBe("outcome_unknown");
  });

  it("no_committed_tool：无工具结果事件 → 无可读取权威结果", () => {
    const events = [ev("message", 1), ev("delta", 2)];
    const decision = decideResume(events, []);
    expect(decision).toEqual({ resume: false, reason: "no_committed_tool" });
  });

  it("前序批次 executed 不影响裁决：只关注最后批次", () => {
    // step1 批次 executed，但最后是 step2 待决 → outcome_unknown（可取续的是最后批）
    const events = [
      ev("message", 1),
      ev("tool_request", 2, "atp:1:1"),
      ev("tool_result", 3, "atp:1:1"),
      ev("tool_request", 4, "atp:2:1"),
      ev("tool_result", 5, "atp:2:1"),
    ];
    const decision = decideResume(events, [exec("atp:1:1", "executed"), exec("atp:2:1", "outcome_unknown")]);
    expect(decision).toEqual({ resume: false, reason: "outcome_unknown" });
  });
});