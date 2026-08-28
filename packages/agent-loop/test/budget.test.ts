/**
 * Aervox｜思隅 @aervox/agent-loop — 阶段 2d 预算与删除/撤权闸门测试
 *
 * 覆盖 AVX-HAR-001 §10（budget：maxTurnDurationMs / maxConsecutiveSameTool）与
 * §11.3（删除/撤权水位未追平 → fail closed）与 §16.1 agent-loop-budget / agent-loop-deletion：
 * - 连续同名工具超限 → Interrupted + rune 诊断（repeat_tool），工具副作用零执行；
 * - 总耗时预算超限 → Interrupted（turn_timeout）；
 * - 删除/撤权闸门阻塞 → 零模型输出、零工具执行，收敛为 Interrupted（deletion_blocked）。
 */
import { describe, expect, it } from "vitest";
import { defaultContextBuilder, executeTurn, InMemoryExecutionStore } from "../src/index.js";
import type { DeletionGatePort, ModelChunk, ModelProviderPort, ToolProviderPort } from "../src/index.js";

const turn = { turnId: "turn_2d", sessionId: "sess_2d", attemptId: "atp_2d", userMessage: "请处理" };

/** 单批多个同名工具调用的 Provider */
const batchSameToolProvider = (name: string, count: number): ModelProviderPort => ({
  id: "batch-same-tool",
  async *stream(): AsyncIterable<ModelChunk> {
    yield {
      text: "",
      isFinal: true,
      toolCalls: Array.from({ length: count }, (_, i) => ({ id: `call_${i}`, name, arguments: { i } })),
    };
  },
});

const noopTools = (called: { invoked: boolean }): ToolProviderPort => ({
  tools: [{ name: "repeat_tool_x", description: "x", readOnly: true }],
  async execute(input) {
    called.invoked = true;
    return { ok: true, output: `done:${(input.arguments as { i: number }).i}` };
  },
});

describe("阶段 2d 预算对账与删除/撤权闸门", () => {
  it("maxConsecutiveSameTool：单批连续同名调用超限 → Interrupted(repeat_tool)，超限调用不执行", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
    let executedCalls = 0;

    const result = await executeTurn(
      {
        execution: store,
        provider: batchSameToolProvider("repeat_tool_x", 4),
        contextBuilder: defaultContextBuilder,
        tools: {
          tools: [{ name: "repeat_tool_x", description: "x", readOnly: true }],
          async execute() {
            executedCalls += 1;
            return { ok: true, output: "ok" };
          },
        },
        options: { maxConsecutiveSameTool: 3 },
      },
      turn,
    );

    expect(result.status).toBe("failed");
    expect((result as { reason: string }).reason).toBe("repeat_tool");
    expect(executedCalls).toBe(3); // 前 3 次允许，第 4 次在同一批次内触发阻断前不执行
    expect(store.attemptStatus(turn.attemptId)).toBe("Interrupted");
    const done = (await store.listEvents(turn.turnId)).find((e) => e.eventType === "done");
    expect((done?.data as { reason?: string }).reason).toBe("repeat_tool");
  });

  it("maxConsecutiveSameTool 未超限时不误伤（3 次 = 允许）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
    let executedCalls = 0;

    const result = await executeTurn(
      {
        execution: store,
        provider: batchSameToolProvider("repeat_tool_x", 3),
        contextBuilder: defaultContextBuilder,
        tools: {
          tools: [{ name: "repeat_tool_x", description: "x", readOnly: true }],
          async execute() {
            executedCalls += 1;
            return { ok: true, output: "ok" };
          },
        },
        options: { maxConsecutiveSameTool: 3, maxSteps: 1 }, // 单批验证：跨 Step 连续同名会累计（见首条用例），此处仅验证批次内不误伤
      },
      turn,
    );

    expect(executedCalls).toBe(3); // 3 次在同名上限内全部执行
    expect(result.status).toBe("failed"); // 单批 3 工具后耗尽 maxSteps=1 → 预算收敛
    expect((result as { reason: string }).reason).toBe("max_steps");
  });

  it("maxTurnDurationMs：耗时超预算 → Interrupted(turn_timeout)", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
    const slowProvider: ModelProviderPort = {
      id: "slow",
      async *stream(): AsyncIterable<ModelChunk> {
        yield { text: "慢。", isFinal: false };
        await new Promise((r) => setTimeout(r, 50));
        yield { text: "完成。", isFinal: true };
      },
    };

    const result = await executeTurn(
      { execution: store, provider: slowProvider, contextBuilder: defaultContextBuilder, options: { maxTurnDurationMs: 1 } },
      turn,
    );

    expect(result.status).toBe("failed");
    expect((result as { reason: string }).reason).toBe("turn_timeout");
    expect(store.attemptStatus(turn.attemptId)).toBe("Interrupted");
  });

  it("删除/撤权闸门阻塞：fail closed，零模型输出、零工具执行，Interrupted(deletion_blocked)", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
    let executedCalls = 0;
    const gate: DeletionGatePort = { isBlocked: async () => true };

    const result = await executeTurn(
      {
        execution: store,
        provider: batchSameToolProvider("repeat_tool_x", 2),
        contextBuilder: defaultContextBuilder,
        tools: { tools: [], async execute() { executedCalls += 1; return { ok: true, output: "x" }; } },
        deletionGate: gate,
      },
      turn,
    );

    expect(result.status).toBe("failed");
    expect((result as { reason: string }).reason).toBe("deletion_blocked");
    expect(executedCalls).toBe(0);
    expect(store.attemptStatus(turn.attemptId)).toBe("Interrupted");
    const events = await store.listEvents(turn.turnId);
    expect(events.map((e) => e.eventType)).toEqual(["message", "done"]); // 无 delta/工具事件
    expect((events[1].data as { reason?: string }).reason).toBe("deletion_blocked");
  });

  it("删除闸门不阻塞时正常放行（gate false 不影响完成路径）", async () => {
    const store = new InMemoryExecutionStore();
    store.seedAttempt({ id: turn.attemptId, turnId: turn.turnId });
    const gate: DeletionGatePort = { isBlocked: async () => false };
    const result = await executeTurn(
      { execution: store, provider: { id: "ok", async *stream() { yield { text: "好。", isFinal: true }; } }, contextBuilder: defaultContextBuilder, deletionGate: gate },
      turn,
    );
    expect(result.status).toBe("completed");
    expect(store.attemptStatus(turn.attemptId)).toBe("Completed");
  });
});