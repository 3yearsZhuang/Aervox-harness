/**
 * Aervox｜思隅 @aervox/agent-loop — 阶段 3a 契约测试（写工具审批待决）
 *
 * 宿主对写工具返回 needsApproval（未执行）时：
 * - Loop 记 tool_approval_required 事件 + 账本 pending_approval，中断（done Interrupted）；
 * - 不写 tool_result（工具未执行，无副作用）；授权后的重放执行由宿主在下一轮驱动。
 */
import { describe, expect, it } from "vitest";
import { createMockToolProvider, createScriptedProvider, defaultContextBuilder, executeTurn, InMemoryExecutionStore } from "../src/index.js";

function makeStore() {
  const store = new InMemoryExecutionStore();
  store.seedAttempt({ id: "atp_3a", turnId: "turn_3a" });
  return store;
}

describe("executeTurn 阶段 3a：写工具审批待决", () => {
  it("无授权写工具：tool_approval_required + 账本 pending_approval + done(Interrupted)，无 tool_result", async () => {
    const store = makeStore();
    const result = await executeTurn(
      {
        execution: store,
        provider: createScriptedProvider([
          {
            text: "需要写一条笔记。",
            toolCalls: [{ id: "call_w", name: "save_memory_note", arguments: { content: "今日复习三角函数" } }],
          },
        ]),
        contextBuilder: defaultContextBuilder,
        tools: createMockToolProvider({
          save_memory_note: () => ({
            ok: false,
            needsApproval: { approvalId: "ap_3a", toolName: "save_memory_note", argumentsHash: "hash:content" },
          }),
        }),
        options: { maxSteps: 2 },
      },
      { turnId: "turn_3a", sessionId: "sess_3a", attemptId: "atp_3a", userMessage: "帮我记一条笔记" },
    );

    expect(result).toMatchObject({ status: "failed", reason: "pending_approval" });

    const events = await store.listEvents("turn_3a");
    const types = events.map((e) => e.eventType);
    expect(types).toEqual([
      "message",
      "delta",
      "tool_request",
      "tool_approval_required",
      "done",
    ]);
    expect(types).not.toContain("tool_result");

    const approval = events.find((e) => e.eventType === "tool_approval_required")?.data as
      | { approvalId: string; toolName: string; argumentsHash: string }
      | undefined;
    expect(approval).toEqual({ approvalId: "ap_3a", toolName: "save_memory_note", argumentsHash: "hash:content" });

    const done = events[events.length - 1]?.data as { status: string; isComplete: boolean };
    expect(done.status).toBe("Interrupted");
    expect(done.isComplete).toBe(false);

    // 副作用账本：pending_approval，未执行
    const log = store.toolExecutionRecords();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ name: "save_memory_note", status: "pending_approval", error: "requires_approval" });

    expect(store.attemptStatus("atp_3a")).toBe("Interrupted");
  });
});