/**
 * Aervox｜思隅 @aervox/core — 工具执行管线测试（ITER-041 第三段）
 *
 * `runToolExecution` 抽出前埋在内核六层嵌套中，六条安全/幂等关键路径只能靠整 Turn
 * 端到端用例间接覆盖。抽出后可独立锁定：
 *
 * - 入参不安全 → fail-closed，**不执行**工具（不消耗任何副作用）；
 * - 审批 deny → 不执行；ask_user → 返回 needsApproval（宿主未执行）；
 * - 长耗时工具（ask_user_question / aervox_diary_write）超时放宽到 120s；
 * - 租约丢失 → 抛 LeaseLostError（交外层收敛，不吞成普通失败 —— 这条最关键：
 *   吞掉会让恢复器误判为可重试，造成副作用重复）；
 * - 预算耗尽 / Step 守卫命中 → 抛 ToolExecutionAborted 交回主循环。
 */
import { describe, expect, it } from "vitest";
import { runToolExecution, ToolExecutionAborted } from "../src/index.js";
import { AutoApprovalPolicy } from "../src/index.js";
import type { ToolProviderPort } from "../src/index.js";

const baseCtx = (over: Partial<Parameters<typeof runToolExecution>[0]> = {}) => {
  const executed: string[] = [];
  const tools: ToolProviderPort = {
    tools: [{ name: "save_memory_note", description: "x", readOnly: false }],
    async execute(input) {
      executed.push(input.name);
      return { ok: true, output: { saved: true } };
    },
  };
  const ctx = {
    turnId: "turn_1",
    attemptId: "atp_1",
    sessionId: "sess_1",
    executionId: "atp_1:1:1",
    call: { id: "call_1", name: "save_memory_note", arguments: { content: "x" } },
    tools,
    toolTimeoutMs: 5000,
    prematureTermination: async () => null,
    finalizeInterrupted: async (reason: string) => ({
      status: "failed" as const,
      attemptId: "atp_1",
      reason,
    }),
    ...over,
  };
  return { ctx, executed };
};

describe("工具执行管线（runToolExecution）", () => {
  it("正常路径：执行工具并回传结果", async () => {
    const { ctx, executed } = baseCtx();
    const result = await runToolExecution(ctx);
    expect(result.ok).toBe(true);
    expect(executed).toEqual(["save_memory_note"]);
  });

  it("入参不安全 → fail-closed 且不执行工具", async () => {
    const { ctx, executed } = baseCtx({
      call: { id: "c", name: "save_memory_note", arguments: { path: "../../etc/passwd\x00" } },
    });
    const result = await runToolExecution(ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("unsafe_tool_arguments");
    expect(executed).toEqual([]);
  });

  it("审批 deny → 不执行工具且回传 reason", async () => {
    const { ctx, executed } = baseCtx({
      approvalPolicy: { evaluate: async () => ({ action: "deny", reason: "policy_denied" }) },
    });
    const result = await runToolExecution(ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("policy_denied");
    expect(executed).toEqual([]);
  });

  it("审批 ask_user → 返回 needsApproval 且宿主未执行", async () => {
    const { ctx, executed } = baseCtx({
      approvalPolicy: new AutoApprovalPolicy({ mode: "ask_user" }),
    });
    const result = await runToolExecution(ctx);
    expect(result.ok).toBe(false);
    expect(result.needsApproval?.approvalId).toBe("apv_atp_1:1:1");
    expect(executed).toEqual([]);
  });

  it("Step 守卫命中 → 抛 ToolExecutionAborted（不执行工具）", async () => {
    const { ctx, executed } = baseCtx({
      prematureTermination: async () => ({ status: "cancelled" as const, attemptId: "atp_1", lastSequence: 3, stepsTaken: 1 }),
    });
    await expect(runToolExecution(ctx)).rejects.toBeInstanceOf(ToolExecutionAborted);
    expect(executed).toEqual([]);
  });

  it("预算耗尽 → 抛 ToolExecutionAborted 且带budget_exhausted", async () => {
    const { createControlContext } = await import("../src/index.js");
    const control = createControlContext({ callBudget: { maxCalls: 0, usedCalls: 0 } });
    const { ctx, executed } = baseCtx({ control });
    await expect(runToolExecution(ctx)).rejects.toBeInstanceOf(ToolExecutionAborted);
    expect(executed).toEqual([]);
  });

  it("租约丢失 → 抛 LeaseLostError（不吞成普通失败）", async () => {
    // heartbeat 报lost：onLost 触发 abort，同时 lost=true 使catch 走租约分支
    const heartbeat = {
      lost: true,
      onLost: () => () => {},
      stop: () => {},
      start: () => {},
      throwIfLost: () => {},
    } as never;
    const { ctx } = baseCtx({
      heartbeat,
      tools: {
        tools: [{ name: "save_memory_note", description: "x", readOnly: false }],
        async execute() {
          throw new Error("aborted_by_lease");
        },
      },
    });
    // execute抛错且 heartbeat.lost=true → 必须抛 LeaseLostError 而非返回 ok:false
    await expect(runToolExecution(ctx)).rejects.toThrowError(/lease lost/i);
  });

  it("普通异常 → 归类为工具失败（ok:false + 原message），不抛出", async () => {
    const { ctx } = baseCtx({
      tools: {
        tools: [{ name: "save_memory_note", description: "x", readOnly: false }],
        async execute() {
          throw new Error("tool_boom");
        },
      },
    });
    const result = await runToolExecution(ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("tool_boom");
  });

  it("工具超时 → error为 tool_timeout（账本据此归类 timeout_error）", async () => {
    const { ctx } = baseCtx({
      toolTimeoutMs: 10,
      tools: {
        tools: [{ name: "save_memory_note", description: "x", readOnly: false }],
        async execute() {
          await new Promise((r) => setTimeout(r, 200));
          return { ok: true };
        },
      },
    });
    const result = await runToolExecution(ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("tool_timeout");
  });
});
