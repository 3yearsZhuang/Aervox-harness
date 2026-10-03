/**
 * Aervox｜思隅 @aervox/core — 工具账本收口测试（ITER-041 第二段）
 *
 * 背景：结果分类与账本收口原是 executor 嵌套深处的 40 行 if/else，与取消、租约丢失、
 * 审批分支交织。分类错误的后果不小——把「需授权」记成「已执行」，恢复器据此重放
 * 会造成副作用重复，正是 AVX-HAR-001 §11.3 要防的情形。
 *
 * 本文件锁定四条契约：
 * - 分类规则：needsApproval / ok / tool_timeout / 其余失败 四路映射；
 * - 需授权时**只更新账本不发 tool_result 事件**（工具未执行，无结果可回填）；
 * - 非需授权时账本收口与 tool_result 事件同事务提交（B4-D）；
 * - 事件序号由调用方 getter 提供 —— 收口消耗的序号必须与主循环共享同一计数器。
 */
import { describe, expect, it } from "vitest";
import {
  classifyToolOutcome,
  InMemoryExecutionStore,
  settleDuplicateToolCall,
  settleToolLedger,
} from "../src/index.js";
import type { ToolCallResult } from "../src/index.js";

const call = { id: "call_1", name: "save_memory_note", arguments: { content: "x" } };

const baseInput = () => {
  const store = new InMemoryExecutionStore();
  store.seedAttempt({ id: "atp_1", turnId: "turn_1" });
  return { store, turnId: "turn_1", attemptId: "atp_1" };
};

describe("工具结果分类（classifyToolOutcome）", () => {
  it("需授权 → pending_approval（不得记为已执行）", () => {
    const result: ToolCallResult = {
      id: "call_1",
      name: "save_memory_note",
      ok: false,
      needsApproval: { approvalId: "apv_1", toolName: "save_memory_note", argumentsHash: "h" },
    };
    expect(classifyToolOutcome(result)).toBe("pending_approval");
  });

  it("成功 → executed", () => {
    expect(classifyToolOutcome({ id: "c", name: "n", ok: true })).toBe("executed");
  });

  it("超时 → timeout_error（与普通拒绝区分，便于判定可否重试）", () => {
    expect(classifyToolOutcome({ id: "c", name: "n", ok: false, error: "tool_timeout" })).toBe("timeout_error");
  });

  it("其余失败 → rejected", () => {
    expect(classifyToolOutcome({ id: "c", name: "n", ok: false, error: "boom" })).toBe("rejected");
  });
});

describe("账本收口（settleToolLedger）", () => {
  it("需授权：账本记 pending_approval 且不发 tool_result 事件", async () => {
    const { store, turnId, attemptId } = baseInput();
    await store.reserveToolExecution({ turnId, attemptId, invocationId: "inv_1", name: call.name, arguments: call.arguments });

    await settleToolLedger({
      execution: store,
      turnId,
      attemptId,
      invocationId: "inv_1",
      expectedFencingToken: 0,
      nextSequence: () => 99,
      call,
      startedAt: new Date().toISOString(),
      result: {
        id: "call_1",
        name: "save_memory_note",
        ok: false,
        needsApproval: { approvalId: "apv_1", toolName: "save_memory_note", argumentsHash: "h" },
      },
    });

    const records = store.toolExecutionRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("pending_approval");
    const events = await store.listEvents(turnId);
    expect(events.some((e) => e.eventType === "tool_result")).toBe(false);
  });

  it("成功：账本 executed 且 tool_result 事件落账（原子提交）", async () => {
    const { store, turnId, attemptId } = baseInput();
    await store.reserveToolExecution({ turnId, attemptId, invocationId: "inv_2", name: call.name, arguments: call.arguments });

    await settleToolLedger({
      execution: store,
      turnId,
      attemptId,
      invocationId: "inv_2",
      expectedFencingToken: 0,
      nextSequence: () => 5,
      call,
      startedAt: new Date().toISOString(),
      result: { id: "call_1", name: "save_memory_note", ok: true, output: { saved: true } },
    });

    const records = store.toolExecutionRecords();
    expect(records[0]?.status).toBe("executed");
    const events = await store.listEvents(turnId);
    const result_ = events.find((e) => e.eventType === "tool_result");
    expect(result_).toBeDefined();
    expect(result_?.sequence).toBe(5);
  });

  it("序号由调用方 getter 决定 —— 每次调用推进计数（不快照）", async () => {
    const { store, turnId, attemptId } = baseInput();
    let counter = 10;
    for (const inv of ["inv_a", "inv_b"]) {
      await store.reserveToolExecution({ turnId, attemptId, invocationId: inv, name: call.name, arguments: call.arguments });
      await settleToolLedger({
        execution: store,
        turnId,
        attemptId,
        invocationId: inv,
        expectedFencingToken: 0,
        nextSequence: () => counter++,
        call,
        startedAt: new Date().toISOString(),
        result: { id: "call_1", name: "save_memory_note", ok: true },
      });
    }
    const events = (await store.listEvents(turnId)).filter((e) => e.eventType === "tool_result");
    expect(events.map((e) => e.sequence)).toEqual([10, 11]);
  });
});

describe("重复调用留痕（settleDuplicateToolCall）", () => {
  it("账本无预留行时插入独立 duplicate 记录并落 tool_result 事件", async () => {
    const { store, turnId, attemptId } = baseInput();
    await settleDuplicateToolCall({
      execution: store,
      turnId,
      attemptId,
      invocationId: "inv_dup",
      expectedFencingToken: 0,
      nextSequence: () => 3,
      call,
      startedAt: new Date().toISOString(),
    });

    const records = store.toolExecutionRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe("duplicate");
    const events = await store.listEvents(turnId);
    const dup = events.find((e) => e.eventType === "tool_result");
    expect(dup?.data).toMatchObject({ ok: false, error: "duplicate_tool_call" });
  });
});
